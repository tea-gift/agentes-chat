import { afterEach, describe, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  authenticateMachine,
  computerTarget,
  createOrganization,
  getDeviceCode,
  issuePairingCode,
  PAIRING_CODE_MINTS_PER_HOUR,
  PairingCodeLimitError,
  pollDeviceToken,
  RIGHT_HAND,
  redeemPairingCode,
  setAgentComputerTarget,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * Pairing codes minted in the chat (ADR 0219): a member who may pair
 * computers mints a short code for their organization, optionally bound to
 * one agent; a computer redeems it with just the short code and its
 * fingerprint, then polls for its token with the issued secret. The secret
 * never goes to the web client, a code is single use and lives 10 minutes,
 * and the named agent gets the computer only when it can take one.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const COMPUTER = {
  name: "MacBook",
  hostname: "mac-new",
  os: "darwin",
  arch: "arm64",
  version: "1.2.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/ana/agentes",
  exec: true,
};
let ipSeq = 0;
/** Redeems `userCode` as a computer, from its own address. */
const redeem = (userCode: string, extra: Partial<typeof COMPUTER> = {}) =>
  redeemPairingCode(deps(), userCode, { ...COMPUTER, ...extra }, { ip: `203.0.113.${++ipSeq}` });
const mint = (actorId: string, orgId: string, input: { agentId?: string | null } = {}) =>
  issuePairingCode(deps(), actorId, orgId, input);
const agentRow = async (id: string) => {
  const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, id));
  if (!row) throw new Error("no agent");
  return row;
};
const machineRow = async (id: string) => {
  const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, id));
  if (!row) throw new Error("no machine");
  return row;
};
const rightHand = async () => {
  const [row] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!row) throw new Error("no right hand");
  return row;
};

describe("minting a pairing code", () => {
  test("a code bound to the org and the agent, and no secret in the answer", async () => {
    f = await setup();
    const issued = await mint(f.owner.id, f.org.id, { agentId: f.agent.id });
    expect(issued.userCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(issued).toMatchObject({
      orgId: f.org.id,
      targetAgentId: f.agent.id,
      targetAgentName: f.agent.name,
      expiresIn: 600,
    });
    expect("deviceCode" in issued).toBe(false);
    const left = new Date(issued.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(9 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000);

    const [row] = await f.db
      .select()
      .from(schema.machineDeviceCodes)
      .where(eq(schema.machineDeviceCodes.userCode, issued.userCode));
    expect(row).toMatchObject({
      orgId: f.org.id,
      issuedVia: "chat",
      status: "confirmed",
      confirmedByUserId: f.owner.id,
      targetAgentId: f.agent.id,
      machineId: null,
    });
    const audit = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "machine.pairing_code_issued"));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ agentId: f.agent.id, agentName: f.agent.name });
    // The audit log is read by the organization's members: it names no code.
    expect(JSON.stringify(audit[0]?.details)).not.toContain(issued.userCode);
  });

  test("a member who may pair computers mints, but only manages the agent they name", async () => {
    f = await setup();
    const carl = await addMember(f.db, f.org.id, "member", "carl");
    const plain = await mint(carl.id, f.org.id);
    expect(plain.userCode).toHaveLength(6);
    expect(plain.targetAgentId).toBeNull();
    // @dev belongs to the owner: a member who doesn't manage it can't name it.
    await expect(mint(carl.id, f.org.id, { agentId: f.agent.id })).rejects.toMatchObject({
      code: "machine.forbidden",
    });
  });

  test("someone outside the organization mints nothing", async () => {
    f = await setup();
    const zed = await addUser(f.db, "zed");
    await expect(mint(zed.id, f.org.id)).rejects.toThrow();
    const { organization: other } = await createOrganization(f.db, f.owner.id, { name: "Other" });
    await expect(mint(f.owner.id, other.id, { agentId: f.agent.id })).rejects.toThrow("Agent not found");
  });

  test("an unknown, archived or foreign agent, or the right hand, is refused", async () => {
    f = await setup({ rightHand: true });
    await expect(mint(f.owner.id, f.org.id, { agentId: crypto.randomUUID() })).rejects.toThrow("Agent not found");
    const { organization: other } = await createOrganization(f.db, f.owner.id, { name: "Other" });
    const [foreign] = await f.db.select().from(schema.agents).where(eq(schema.agents.orgId, other.id));
    if (foreign) {
      await expect(mint(f.owner.id, f.org.id, { agentId: foreign.id })).rejects.toThrow("Agent not found");
    }
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    await expect(mint(f.owner.id, f.org.id, { agentId: f.agent.id })).rejects.toThrow("Agent not found");
    await f.db.update(schema.agents).set({ archivedAt: null }).where(eq(schema.agents.id, f.agent.id));
    const hand = await rightHand();
    await expect(mint(f.owner.id, f.org.id, { agentId: hand.id })).rejects.toMatchObject({
      code: "agent.right_hand_permanent",
    });
  });

  test("the mint cap: the 11th code in an hour is refused", async () => {
    f = await setup();
    expect(PAIRING_CODE_MINTS_PER_HOUR).toBe(10);
    for (let n = 0; n < PAIRING_CODE_MINTS_PER_HOUR; n++) await mint(f.owner.id, f.org.id);
    await expect(mint(f.owner.id, f.org.id)).rejects.toBeInstanceOf(PairingCodeLimitError);
  });
});

describe("redeeming a pairing code", () => {
  test("the short code and the fingerprint become a machine with the agent on it", async () => {
    f = await setup();
    const issued = await mint(f.owner.id, f.org.id, { agentId: f.agent.id });
    // A minted code never answers the confirm page: it is confirmed already.
    await expect(getDeviceCode(deps(), issued.userCode, f.owner.id)).rejects.toThrow("This code is unknown or expired");

    const redeemed = await redeem(issued.userCode);
    expect(redeemed.deviceCode).toMatch(/^[\w-]{43}$/);
    expect(redeemed).toMatchObject({
      userCode: issued.userCode,
      org: { id: f.org.id, name: "Acme" },
      targetAgent: { id: f.agent.id, name: f.agent.name },
      assignedAgent: { id: f.agent.id, name: f.agent.name },
      assignmentSkipped: null,
    });
    expect(redeemed.expiresIn).toBeGreaterThan(9 * 60);
    expect(redeemed.interval).toBe(3);

    const row = await machineRow(redeemed.machineId);
    expect(row).toMatchObject({
      orgId: f.org.id,
      kind: "connected",
      name: "MacBook",
      hostname: "mac-new",
      pairedByUserId: f.owner.id,
    });
    expect(await computerTarget(f.db, f.org.id, f.agent.id)).toMatchObject({
      kind: "machine",
      machineId: redeemed.machineId,
    });
    expect((await agentRow(f.agent.id)).machineId).toBe(redeemed.machineId);

    // The token, once, from the issued secret.
    const token = await pollDeviceToken(deps(), redeemed.deviceCode);
    if (!token.ok) throw new Error(token.error);
    expect(token).toMatchObject({ machineId: redeemed.machineId, name: "MacBook" });
    expect(token.token).toStartWith("agm_");
    expect((await authenticateMachine(f.db, token.token))?.id).toBe(redeemed.machineId);
    expect(await pollDeviceToken(deps(), redeemed.deviceCode)).toEqual({ ok: false, error: "expired_token" });

    const connected = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "machine.connected"));
    expect(connected).toHaveLength(1);
    expect(connected[0]?.targetId).toBe(redeemed.machineId);
    const targeted = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.computer_target"));
    expect(targeted).toHaveLength(1);
    expect(targeted[0]?.details).toMatchObject({ from: null, to: redeemed.machineId });
  });

  test("an unknown code, a second redeem and an expired code are refused", async () => {
    f = await setup();
    await expect(redeem("AAAAAA")).rejects.toMatchObject({ code: "machine.device_not_found" });
    await expect(redeem("short")).rejects.toMatchObject({ code: "machine.device_not_found" });

    const issued = await mint(f.owner.id, f.org.id);
    await redeem(issued.userCode);
    await expect(redeem(issued.userCode)).rejects.toMatchObject({ code: "machine.device_not_found" });

    const late = await mint(f.owner.id, f.org.id);
    const after = () => new Date(Date.now() + 11 * 60_000);
    await expect(
      redeemPairingCode({ ...deps(), now: after }, late.userCode, COMPUTER, { ip: "203.0.113.99" }),
    ).rejects.toMatchObject({ code: "machine.device_not_found" });
  });

  test("no agent named: the computer stays unassigned, and the token still comes", async () => {
    f = await setup();
    const issued = await mint(f.owner.id, f.org.id);
    const redeemed = await redeem(issued.userCode);
    expect(redeemed).toMatchObject({ targetAgent: null, assignedAgent: null, assignmentSkipped: null });
    expect(await computerTarget(f.db, f.org.id, f.agent.id)).toEqual({ kind: "none" });
    const token = await pollDeviceToken(deps(), redeemed.deviceCode);
    expect(token).toMatchObject({ ok: true, machineId: redeemed.machineId });
  });

  test("the named agent already has a computer: it stays where it is, and the token still comes", async () => {
    f = await setup();
    const other = await pairMachine(deps(), f.owner.id, f.org.id, { hostname: "linux" });
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, other.machineId);

    const issued = await mint(f.owner.id, f.org.id, { agentId: f.agent.id });
    const redeemed = await redeem(issued.userCode);
    expect(redeemed).toMatchObject({ assignedAgent: null, assignmentSkipped: "agent_has_machine" });
    expect(redeemed.targetAgent).toMatchObject({ id: f.agent.id });
    expect(await computerTarget(f.db, f.org.id, f.agent.id)).toMatchObject({ machineId: other.machineId });
    const token = await pollDeviceToken(deps(), redeemed.deviceCode);
    expect(token).toMatchObject({ ok: true, machineId: redeemed.machineId });
    const targeted = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.computer_target"));
    // The move onto the first computer only: no second target change.
    expect(targeted).toHaveLength(1);
  });

  test("the named agent is gone by redeem time: the computer still connects, unassigned", async () => {
    f = await setup();
    const issued = await mint(f.owner.id, f.org.id, { agentId: f.agent.id });
    await f.db.delete(schema.agents).where(eq(schema.agents.id, f.agent.id));
    const redeemed = await redeem(issued.userCode);
    expect(redeemed).toMatchObject({
      targetAgent: null,
      assignedAgent: null,
      assignmentSkipped: "agent_not_found",
    });
    const token = await pollDeviceToken(deps(), redeemed.deviceCode);
    expect(token).toMatchObject({ ok: true });
  });
});
