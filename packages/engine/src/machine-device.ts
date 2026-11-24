import { randomBytes, randomInt } from "node:crypto";
import { type MachineOs, MIN_RUNNER_PROTOCOL, type PubSub } from "@agenteschat/adapters";
import { and, count, type Database, eq, gt, inArray, isNull, or, schema } from "@agenteschat/db";
import { managesAgent } from "./audience";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import type { DeviceAudience } from "./devices";
import { ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import {
  cleanMachineName,
  generateMachineToken,
  MACHINE_CONTROL_TOPIC,
  type MachineRow,
  type MachineView,
  machineView,
  mayBeHome,
  publishMachineAgentsChanged,
  sha256Hex,
} from "./machines";
import { notifyMachineConnected } from "./notification-producers";
import { can, getMembership, requireActiveMembership } from "./organizations";
import { isRightHand, rightHandPermanent } from "./right-hand";
import { closedRefusal } from "./standing";
import { withoutTrailingSlashes } from "./url-text";

const { agents, machineDeviceCodes, machines, organizations, users } = schema;

/**
 * Connecting a computer (ADR 0036 §5): a device-code flow like OAuth's. The
 * computer (the desktop app or `agentes-runner pair`) asks for a code, shows
 * it with a link, and polls; a signed-in person opens the link, compares the
 * code, picks the organization and confirms (or says "it wasn't me"). The
 * machine row is made on confirm, with no token yet; the token is issued to
 * the computer's next poll, exactly once, and only its hash is kept.
 *
 * Against a link sent by someone else (device-code phishing): 10 minutes,
 * single use, the page shows what asked and from roughly where, admins are
 * notified of every new computer, and a new computer gets no agents until
 * someone points one at it.
 *
 * Reconnecting: a computer the server refused (removed, token revoked) asks
 * again with `previousMachineId` and the token it had for that machine
 * (`previousToken`), which proves it is that computer: machine ids are seen by
 * every member, so an id alone would let any computer take over another's row
 * (its permissions and agents). A removed computer's token hash stays on its
 * row for this (`removeMachine`; a removed row never authenticates). Without a
 * matching token, or for the workspace's own computers (`host`, `managed`), the
 * code is an ordinary new computer. When the person confirming picks that
 * machine's organization and may manage it (admin, or who paired it), the
 * same row comes back: same name and permissions, a fresh token, and the
 * agents that used it before its removal get it back. Anything else (other
 * organization, no permission, unknown id) is an ordinary new computer.
 */
export type DeviceCodeRow = typeof machineDeviceCodes.$inferSelect;

/** A code lives this long. */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;
/** Seconds the computer waits between polls (`slow_down` when faster). */
export const DEVICE_POLL_INTERVAL_S = 3;
/** Pending codes one address may hold at once. */
export const DEVICE_MAX_PENDING_PER_IP = 10;
/** No letters or digits people confuse (0/O, 1/I/L). */
export const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const USER_CODE_LENGTH = 6;

/** Polls this much earlier than the interval still count as on time (network jitter). */
const POLL_SLACK_MS = 750;
const OSES: MachineOs[] = ["linux", "darwin", "windows"];

export interface DeviceDeps {
  db: Database;
  pubsub?: PubSub;
  now?: () => Date;
}

/** One address holds too many pending codes (the route answers 429). */
export class DeviceCodeLimitError extends Error {
  constructor() {
    super("Too many pending connection codes from this address. Wait a few minutes and try again.");
    this.name = "DeviceCodeLimitError";
  }
}

/** Pairing codes one member may mint for one organization in an hour (the mint route answers 429). */
export const PAIRING_CODE_MINTS_PER_HOUR = 10;

/** Too many pairing codes minted lately (the mint route answers 429). */
export class PairingCodeLimitError extends Error {
  constructor() {
    super("Too many pairing codes minted for this organization lately. Wait a while and try again.");
    this.name = "PairingCodeLimitError";
  }
}

/** Why a named agent didn't get the computer a pairing code redeemed. */
export type PairingAssignmentSkipped =
  | "agent_not_found"
  | "agent_archived"
  | "agent_has_machine"
  | "agent_right_hand"
  | "agent_not_home";

/** `K7Q4ZP`: uniform over the alphabet (`randomInt` has no modulo bias). */
export function generateUserCode() {
  let code = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

/** A user code as people may type or paste it (`k7q·4zp`, `K7Q-4ZP`): letters and digits, upper case. */
export const normalizeUserCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** `K7Q·4ZP`, how both sides show it. */
export const formatUserCode = (code: string) => `${code.slice(0, 3)}·${code.slice(3)}`;

export interface DeviceStartInput {
  name: string;
  os: string;
  arch: string;
  hostname: string;
  version: string;
  /** Optional extras a runner may send; copied to the machine (its `hello` updates them anyway). */
  protocol?: number;
  workspace?: string;
  exec?: boolean;
  /** The machine this computer was before (it was refused); see "Reconnecting" above. */
  previousMachineId?: string;
  /** The token this computer had for `previousMachineId`: without it, no reconnect. */
  previousToken?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeviceRequester {
  ip: string;
  /** Best effort, from the requesting address ("São Paulo, BR"); absent when unknown. */
  approxLocation?: string | null;
}

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();

/**
 * `POST /api/machines/device` (no session): a new code for the computer.
 * At most `DEVICE_MAX_PENDING_PER_IP` pending codes per address. With `link` (a connect link, `device-links.ts`) the
 * code is that link's organization's and only the link's maker can approve it: nobody can confirm it by typing it.
 */
export async function startDeviceCode(
  deps: DeviceDeps & { publicUrl: string },
  input: DeviceStartInput,
  requester: DeviceRequester,
  link?: { id: string; orgId: string },
) {
  if (input.protocol !== undefined && input.protocol < MIN_RUNNER_PROTOCOL) {
    throw new ValidationError("This runner is too old. Download the latest one.", "machine.outdated");
  }
  const now = nowOf(deps);
  const ip = requester.ip.slice(0, 100);
  const [pending] = await deps.db
    .select({ n: count() })
    .from(machineDeviceCodes)
    .where(
      and(
        eq(machineDeviceCodes.requesterIp, ip),
        eq(machineDeviceCodes.status, "pending"),
        gt(machineDeviceCodes.expiresAt, now),
      ),
    );
  if (Number(pending?.n ?? 0) >= DEVICE_MAX_PENDING_PER_IP) throw new DeviceCodeLimitError();
  const previousMachineId = await provenPreviousMachine(deps.db, input);
  const deviceCode = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_MS);
  for (let attempt = 0; ; attempt++) {
    const userCode = generateUserCode();
    try {
      await deps.db.insert(machineDeviceCodes).values({
        deviceCodeHash: sha256Hex(deviceCode),
        userCode,
        name: cleanMachineName(input.name),
        os: OSES.find((o) => o === input.os) ?? "other",
        arch: input.arch.slice(0, 40),
        hostname: input.hostname.slice(0, 200),
        runnerVersion: input.version.slice(0, 40),
        ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
        ...(input.workspace !== undefined ? { workspace: input.workspace.slice(0, 500) } : {}),
        ...(input.exec !== undefined ? { execAllowed: input.exec } : {}),
        ...(previousMachineId ? { previousMachineId } : {}),
        ...(link ? { orgId: link.orgId, linkId: link.id } : {}),
        requesterIp: ip,
        approxLocation: requester.approxLocation?.slice(0, 120) || null,
        expiresAt,
        createdAt: now,
      });
      const base = withoutTrailingSlashes(deps.publicUrl);
      return {
        deviceCode,
        userCode,
        verificationUrl: `${base}/conectar?code=${userCode}`,
        expiresIn: DEVICE_CODE_TTL_MS / 1000,
        interval: DEVICE_POLL_INTERVAL_S,
      };
    } catch (error) {
      // Another pending code has the same user code (rare): draw again.
      if (!isUniqueViolation(error) || attempt >= 4) throw error;
    }
  }
}

/**
 * The machine a code may ask to come back as: only one whose token the
 * computer still holds (the hash stays on a removed row, see "Reconnecting"),
 * and only a computer someone connected (`connected`), never the server's own
 * (`host`) or the workspace's provisioned one (`managed`). Null otherwise.
 */
async function provenPreviousMachine(db: Database, input: DeviceStartInput): Promise<string | null> {
  const id = input.previousMachineId;
  const token = input.previousToken;
  if (!id || !UUID_RE.test(id) || !token) return null;
  const [machine] = await db
    .select({ id: machines.id })
    .from(machines)
    .where(
      and(eq(machines.id, id.toLowerCase()), eq(machines.kind, "connected"), eq(machines.tokenHash, sha256Hex(token))),
    );
  return machine?.id ?? null;
}

export type DeviceTokenError = "authorization_pending" | "slow_down" | "access_denied" | "expired_token";

export type DeviceTokenResult =
  | {
      ok: true;
      token: string;
      machineId: string;
      name: string;
      org: { id: string; name: string };
      /** Who may use it, as it joined, and the name of whoever connected it: the computer says so when it connects. */
      audience: DeviceAudience["mode"];
      owner: string | null;
    }
  | { ok: false; error: DeviceTokenError };

/**
 * `POST /api/machines/device/token` (no session): the computer's poll.
 * Pending until confirmed (`slow_down` when polled faster than the
 * interval), `access_denied` after "it wasn't me", `expired_token` after 10
 * minutes or once the token was taken. Confirmed: the machine's token, once.
 */
export async function pollDeviceToken(deps: DeviceDeps, deviceCode: string): Promise<DeviceTokenResult> {
  const now = nowOf(deps);
  const [row] = await deps.db
    .select()
    .from(machineDeviceCodes)
    .where(eq(machineDeviceCodes.deviceCodeHash, sha256Hex(deviceCode)));
  if (!row) return { ok: false, error: "expired_token" };
  if (row.status === "denied") return { ok: false, error: "access_denied" };
  if (row.status === "redeemed") return { ok: false, error: "expired_token" };
  if (row.expiresAt.getTime() <= now.getTime()) {
    // Confirmed but never collected: the machine made on confirm can't ever connect.
    // A reconnected machine stays (offline, no token): it has agents and permissions to keep.
    if (row.status === "confirmed" && row.machineId && row.machineId !== row.previousMachineId) {
      await dropUncollected(deps, row, now);
    }
    return { ok: false, error: "expired_token" };
  }
  if (row.status === "pending") {
    const early =
      row.lastPolledAt !== null &&
      now.getTime() - row.lastPolledAt.getTime() < DEVICE_POLL_INTERVAL_S * 1000 - POLL_SLACK_MS;
    await deps.db
      .update(machineDeviceCodes)
      .set({ lastPolledAt: now })
      .where(eq(machineDeviceCodes.id, row.id))
      .catch(() => undefined);
    return { ok: false, error: early ? "slow_down" : "authorization_pending" };
  }
  // Confirmed: the token goes out once (two polls racing: one wins).
  const token = generateMachineToken();
  const issued = await deps.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(machineDeviceCodes)
      .set({ status: "redeemed", lastPolledAt: now })
      .where(and(eq(machineDeviceCodes.id, row.id), eq(machineDeviceCodes.status, "confirmed")))
      .returning();
    if (!claimed?.machineId || !claimed.orgId) return null;
    const [machine] = await tx
      .update(machines)
      .set({ tokenHash: sha256Hex(token), updatedAt: now })
      .where(and(eq(machines.id, claimed.machineId), eq(machines.orgId, claimed.orgId), isNull(machines.deletedAt)))
      .returning();
    // Removed on the site before the computer collected it.
    if (!machine) return null;
    const [org] = await tx
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, machine.orgId));
    const [owner] = machine.pairedByUserId
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, machine.pairedByUserId))
      : [];
    return { machine, org: org ?? { id: machine.orgId, name: "" }, owner: owner?.name ?? null };
  });
  if (!issued) return { ok: false, error: "expired_token" };
  await recordAudit(deps.db, {
    orgId: issued.machine.orgId,
    // Nobody confirmed a code the operator's provisioner issued (ADR 0056 §10).
    actor: row.confirmedByUserId ? { type: "person", id: row.confirmedByUserId } : { type: "system", id: null },
    action: "machine.paired",
    target: { type: "machine", id: issued.machine.id },
    details: { name: issued.machine.name, hostname: issued.machine.hostname, os: issued.machine.os },
  });
  return {
    ok: true,
    token,
    machineId: issued.machine.id,
    name: issued.machine.name,
    org: issued.org,
    audience: issued.machine.audienceMode,
    owner: issued.owner,
  };
}

/** A machine whose code expired before the computer took its token: removed (it has no token to connect with). */
async function dropUncollected(deps: DeviceDeps, row: DeviceCodeRow, now: Date) {
  if (!row.machineId || !row.orgId) return;
  const [dropped] = await deps.db
    .update(machines)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(machines.id, row.machineId),
        eq(machines.orgId, row.orgId),
        isNull(machines.tokenHash),
        isNull(machines.deletedAt),
      ),
    )
    .returning({ id: machines.id });
  if (!dropped) return;
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId: row.orgId,
    event: { type: "machine.deleted", machineId: row.machineId },
  });
}

/** A pending, unexpired code by what the person typed or followed; null otherwise. A connect link's never is. */
async function pendingCode(db: Database, userCode: string, now: Date) {
  const code = normalizeUserCode(userCode);
  if (code.length !== USER_CODE_LENGTH) return null;
  const [row] = await db
    .select()
    .from(machineDeviceCodes)
    .where(
      and(
        eq(machineDeviceCodes.userCode, code),
        eq(machineDeviceCodes.status, "pending"),
        gt(machineDeviceCodes.expiresAt, now),
        isNull(machineDeviceCodes.linkId),
      ),
    );
  return row ?? null;
}

const notFound = () =>
  new NotFoundError("This code is unknown or expired. Start again on the computer.", "machine.device_not_found");

/**
 * What the confirm page shows (`GET /api/app/machines/device/{userCode}`), for
 * any signed-in person. `reconnect` only when the code asks to come back as a
 * machine this person may manage (others see an ordinary new computer).
 */
export async function getDeviceCode(deps: DeviceDeps, userCode: string, actorId?: string) {
  const row = await pendingCode(deps.db, userCode, nowOf(deps));
  if (!row) throw notFound();
  const view = deviceCodeView(row);
  if (!actorId || !row.previousMachineId) return view;
  const target = await reconnectTarget(deps.db, actorId, row.previousMachineId);
  if (!target) return view;
  const { machine, orgName } = target;
  return { ...view, reconnect: { machineId: machine.id, name: machine.name, orgId: machine.orgId, orgName } };
}

/**
 * The machine a code asks to come back as, when `actorId` may manage it: a
 * member of its organization who can post and is an admin (`configure`) or
 * paired it. Removed machines count (that is the point). Null otherwise.
 */
async function reconnectTarget(
  db: Database,
  actorId: string,
  machineId: string,
  orgId?: string,
): Promise<{ machine: MachineRow; orgName: string } | null> {
  const [machine] = await db
    .select()
    .from(machines)
    .where(and(eq(machines.id, machineId), ...(orgId ? [eq(machines.orgId, orgId)] : [])));
  // Only a computer someone connected: the workspace's own (`managed`, its provisioner's code) and the
  // server's own (`host`, its sync) never come back as someone's computer.
  if (machine?.kind !== "connected") return null;
  const member = await getMembership(db, actorId, machine.orgId);
  if (!member || closedRefusal(member.standing) || !can(member, "pair_computers")) return null;
  if (!can(member, "configure") && machine.pairedByUserId !== actorId) return null;
  return { machine, orgName: member.orgName };
}

export function deviceCodeView(row: DeviceCodeRow): DeviceCodeView {
  return {
    userCode: row.userCode,
    name: row.name,
    os: row.os,
    arch: row.arch,
    hostname: row.hostname,
    version: row.runnerVersion,
    approxLocation: row.approxLocation ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export interface DeviceCodeView {
  userCode: string;
  name: string;
  os: string;
  arch: string;
  hostname: string;
  version: string;
  approxLocation: string | null;
  createdAt: string;
  expiresAt: string;
  /** The code reconnects this machine (shown only to people who may manage it). */
  reconnect?: { machineId: string; name: string; orgId: string; orgName: string };
}

/**
 * `POST …/organizations/{orgId}/machines/device/{userCode}/confirm`: a member
 * who can post connects the computer to this organization. The machine is
 * made now (no token yet, no agents), the org's admins are notified, and the
 * computer gets its token on its next poll. A reconnect (the code names a
 * machine of this organization the person may manage) reuses that row
 * instead: see "Reconnecting" above.
 */
export async function confirmDeviceCode(
  deps: DeviceDeps,
  actorId: string,
  orgId: string,
  userCode: string,
  input: { name?: string | null },
): Promise<MachineView> {
  await requirePairing(deps.db, actorId, orgId);
  const pending = await pendingCode(deps.db, userCode, nowOf(deps));
  if (!pending) throw notFound();
  return confirmPendingCode(deps, actorId, orgId, pending, input);
}

async function requirePairing(db: Database, actorId: string, orgId: string) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  if (!can(membership, "pair_computers")) {
    throw new ForbiddenError(
      "Only members who can post in the organization can connect a computer",
      "machine.forbidden",
    );
  }
  return membership;
}

/**
 * `confirmDeviceCode` for a code already found pending (a connect link's request, `approveJoinRequest`), with the
 * rule a new computer starts with (`audience`, else Only its owner).
 */
export async function confirmPendingCode(
  deps: DeviceDeps,
  actorId: string,
  orgId: string,
  pending: DeviceCodeRow,
  input: { name?: string | null; audience?: DeviceAudience },
): Promise<MachineView> {
  await requirePairing(deps.db, actorId, orgId);
  const now = nowOf(deps);
  const previous = pending.previousMachineId
    ? ((await reconnectTarget(deps.db, actorId, pending.previousMachineId, orgId))?.machine ?? null)
    : null;
  const machine = await deps.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(machineDeviceCodes)
      .set({ status: "confirmed", orgId, confirmedByUserId: actorId, decidedAt: now })
      .where(
        and(
          eq(machineDeviceCodes.id, pending.id),
          eq(machineDeviceCodes.status, "pending"),
          gt(machineDeviceCodes.expiresAt, now),
        ),
      )
      .returning();
    if (!claimed) return null;
    const reported = {
      hostname: claimed.hostname,
      os: claimed.os,
      arch: claimed.arch,
      runnerVersion: claimed.runnerVersion,
      ...(claimed.protocol !== null ? { protocol: claimed.protocol } : {}),
      ...(claimed.workspace !== null ? { workspace: claimed.workspace } : {}),
      ...(claimed.execAllowed !== null ? { execAllowed: claimed.execAllowed } : {}),
    };
    let row: MachineRow | undefined;
    let restored: string[] = [];
    if (previous) {
      // The same row: name and permissions stay; the old token stops working
      // now (the new one is issued to the computer's next poll).
      [row] = await tx
        .update(machines)
        .set({
          ...reported,
          tokenHash: null,
          online: false,
          connectedReplica: null,
          deletedAt: null,
          previousAgentIds: [],
          updatedAt: now,
        })
        .where(and(eq(machines.id, previous.id), eq(machines.orgId, orgId)))
        .returning();
      if (row && previous.previousAgentIds.length > 0) {
        // Back to the agents that used it, unless they got another computer meanwhile.
        const back = await tx
          .update(agents)
          .set({ machineId: row.id, updatedAt: now })
          .where(
            and(
              eq(agents.orgId, orgId),
              inArray(agents.id, previous.previousAgentIds),
              isNull(agents.machineId),
              isNull(agents.archivedAt),
            ),
          )
          .returning({ id: agents.id });
        restored = back.map((a) => a.id);
      }
    } else {
      const name = cleanMachineName(input.name) || claimed.name || claimed.hostname.slice(0, 80) || "Computer";
      const rule = input.audience
        ? {
            audienceMode: input.audience.mode,
            audienceUserIds: input.audience.userIds,
            audienceRoleIds: input.audience.roleIds,
          }
        : {};
      [row] = await tx
        .insert(machines)
        .values({ orgId, name, pairedByUserId: actorId, ...reported, ...rule, createdAt: now, updatedAt: now })
        .returning();
    }
    if (!row) throw new Error("machine write returned nothing");
    await tx.update(machineDeviceCodes).set({ machineId: row.id }).where(eq(machineDeviceCodes.id, claimed.id));
    return { row, restored, ip: claimed.requesterIp, location: claimed.approxLocation };
  });
  if (!machine) throw notFound();
  const { row, restored } = machine;
  const where = {
    name: row.name,
    hostname: row.hostname,
    os: row.os,
    arch: row.arch,
    ip: machine.ip,
    ...(machine.location ? { location: machine.location } : {}),
  };
  if (previous) {
    for (const agentId of restored) caches.agents.delete(`${orgId}:${agentId}`);
    // A socket still open with the old token (another copy of the runner) is closed.
    await deps.pubsub
      ?.publish(MACHINE_CONTROL_TOPIC, { type: "machine.revoke", machineId: row.id })
      .catch(() => undefined);
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "machine.reconnected",
      target: { type: "machine", id: row.id },
      details: { ...where, wasRemoved: previous.deletedAt !== null, agents: restored },
    });
  } else {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "machine.connected",
      target: { type: "machine", id: row.id },
      details: where,
    });
  }
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "machine.paired", machineId: row.id, name: row.name },
  });
  for (const agentId of restored) {
    await publishOrgEvent(deps.pubsub, {
      type: "org.broadcast",
      orgId,
      event: {
        type: "agent.computer",
        agentId,
        target: { kind: "machine", machineId: row.id, name: row.name, online: false },
      },
    });
  }
  await publishMachineAgentsChanged(deps.pubsub, orgId);
  await notifyMachineConnected(deps, row, actorId).catch(() => undefined);
  return machineView(deps.db, actorId, orgId, row.id);
}

/** `POST /api/app/machines/device/{userCode}/deny` ("Não fui eu"): the computer's next poll gets `access_denied`. */
export async function denyDeviceCode(deps: DeviceDeps, actorId: string, userCode: string) {
  const now = nowOf(deps);
  const [denied] = await deps.db
    .update(machineDeviceCodes)
    .set({ status: "denied", confirmedByUserId: actorId, decidedAt: now })
    .where(
      and(
        eq(machineDeviceCodes.userCode, normalizeUserCode(userCode)),
        eq(machineDeviceCodes.status, "pending"),
        gt(machineDeviceCodes.expiresAt, now),
        isNull(machineDeviceCodes.linkId),
      ),
    )
    .returning({ id: machineDeviceCodes.id });
  if (!denied) throw notFound();
}

// ---------------------------------------------------------------------------
// Pairing codes minted in the chat (ADR 0219)
// ---------------------------------------------------------------------------

/**
 * A pairing code minted in the chat (ADR 0219): a member who may pair
 * computers asks the server for a short code for their organization, reads it
 * to whoever sits at a computer, and that computer redeems it with
 * `agentes-runner pair --code`. It is the device-code flow with the human
 * confirm step moved to the mint: the code is born `confirmed` for its org,
 * bound to whoever minted it and optionally to one agent, and lives
 * `DEVICE_CODE_TTL_MS`. The computer trades the short code (plus what it is:
 * its fingerprint) for the polling secret at redeem time; the secret itself
 * is never returned to the web client, and the mint never sees it either —
 * the row holds a hash of random bytes nobody was told.
 *
 * The mint is the trust boundary: only a member who may pair computers, at
 * most `PAIRING_CODE_MINTS_PER_HOUR` an hour per organization, and the
 * target agent only when the minter manages it. A code is single use (the
 * redeem claims it by setting `machine_id`, where it was null), and guessing
 * is bounded the same way as the confirm page: 6 characters over 31 symbols
 * (~887M), a per-address budget on the redeem route, 10 minutes to live.
 * A redeemed code behaves like a web-confirmed one from then on: the machine
 * is made at redeem, the token is issued to the first poll, and a machine
 * whose token is never collected is dropped on expiry.
 */

export interface IssuedPairingCode {
  userCode: string;
  orgId: string;
  targetAgentId: string | null;
  targetAgentName: string | null;
  expiresAt: string;
  expiresIn: number;
}

export interface RedeemedPairingCode {
  /** The polling secret, returned once, to the computer that held the short code. Never shown in the app. */
  deviceCode: string;
  userCode: string;
  machineId: string;
  org: { id: string; name: string };
  /** The agent the code named, as it stood at redeem time; null when none was named, or it is gone. */
  targetAgent: { id: string; name: string } | null;
  /** The agent now on this computer; null when none was named, or it couldn't take it (`assignmentSkipped`). */
  assignedAgent: { id: string; name: string } | null;
  assignmentSkipped: PairingAssignmentSkipped | null;
  /** Seconds left on the code: poll at once. */
  expiresIn: number;
  interval: number;
}

/**
 * A live code with this short code, if one exists: a pending device code, or
 * a chat-issued code not redeemed yet. Minting draws again while one lives,
 * so two live codes never share the characters (the partial unique index
 * covers pending codes only).
 */
async function liveCodeWithUserCode(db: Database, userCode: string, now: Date) {
  const [row] = await db
    .select({ id: machineDeviceCodes.id })
    .from(machineDeviceCodes)
    .where(
      and(
        eq(machineDeviceCodes.userCode, userCode),
        gt(machineDeviceCodes.expiresAt, now),
        or(
          eq(machineDeviceCodes.status, "pending"),
          and(eq(machineDeviceCodes.status, "confirmed"), isNull(machineDeviceCodes.machineId)),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * `POST …/organizations/{orgId}/machines/device-codes` (a signed-in member
 * who may pair computers): a short code for the organization, optionally
 * bound to one agent the minter manages. The code itself is the credential:
 * the answer carries no polling secret, and the audit entry names no code.
 */
export async function issuePairingCode(
  deps: DeviceDeps,
  actorId: string,
  orgId: string,
  input: { agentId?: string | null } = {},
): Promise<IssuedPairingCode> {
  const membership = await requirePairing(deps.db, actorId, orgId);
  let target: { id: string; name: string } | null = null;
  if (input.agentId) {
    const [agent] = await deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.orgId, orgId)));
    if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
    if (isRightHand(agent)) throw rightHandPermanent("given a computer");
    if (!managesAgent(agent, actorId, membership)) {
      throw new ForbiddenError("Only an admin or the agent's owner can choose its computer", "machine.forbidden");
    }
    if (!mayBeHome({ kind: "connected" })) {
      throw new ForbiddenError(
        "Agents live on the workspace computer here: a pairing code can't name one.",
        "device.not_home",
      );
    }
    target = agent;
  }
  const now = nowOf(deps);
  const [minted] = await deps.db
    .select({ n: count() })
    .from(machineDeviceCodes)
    .where(
      and(
        eq(machineDeviceCodes.issuedVia, "chat"),
        eq(machineDeviceCodes.confirmedByUserId, actorId),
        eq(machineDeviceCodes.orgId, orgId),
        gt(machineDeviceCodes.createdAt, new Date(now.getTime() - 60 * 60_000)),
      ),
    );
  if (Number(minted?.n ?? 0) >= PAIRING_CODE_MINTS_PER_HOUR) throw new PairingCodeLimitError();
  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_MS);
  for (let attempt = 0; ; attempt++) {
    const userCode = generateUserCode();
    if (await liveCodeWithUserCode(deps.db, userCode, now)) {
      if (attempt >= 4) throw new Error("could not draw a free pairing code");
      continue;
    }
    try {
      // The polling secret's hash: random bytes nobody was told (redeem
      // rotates the secret before handing it out, so this hash is never used).
      const [row] = await deps.db
        .insert(machineDeviceCodes)
        .values({
          orgId,
          issuedVia: "chat",
          deviceCodeHash: sha256Hex(randomBytes(32).toString("base64url")),
          userCode,
          status: "confirmed",
          name: "",
          os: "other",
          arch: "",
          hostname: "",
          runnerVersion: "",
          ...(target ? { targetAgentId: target.id } : {}),
          requesterIp: "",
          confirmedByUserId: actorId,
          decidedAt: now,
          expiresAt,
          createdAt: now,
        })
        .returning({ id: machineDeviceCodes.id });
      if (!row) throw new Error("pairing code insert returned nothing");
      await recordAudit(deps.db, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "machine.pairing_code_issued",
        target: { type: "organization", id: orgId },
        // Never the code itself: the audit log is read by the organization's members.
        details: {
          ...(target ? { agentId: target.id, agentName: target.name } : {}),
          expiresAt: expiresAt.toISOString(),
        },
      });
      return {
        userCode,
        orgId,
        targetAgentId: target?.id ?? null,
        targetAgentName: target?.name ?? null,
        expiresAt: expiresAt.toISOString(),
        expiresIn: DEVICE_CODE_TTL_MS / 1000,
      };
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 4) throw error;
    }
  }
}

/** The computer's half of a pairing code: its self-report, as for `POST /api/machines/device`. */
export type RedeemPairingCodeInput = Omit<DeviceStartInput, "previousMachineId" | "previousToken">;

/**
 * `POST /api/machines/device/redeem` (no session): a computer trades a valid
 * short code and its fingerprint for the polling secret. The machine is made
 * now (kind `connected`, paired by whoever minted the code), the named agent
 * is put on it when it can take a computer, and the secret goes out once:
 * the claim sets `machine_id` where it was null, so a second redeem finds
 * nothing to claim. The computer then polls `…/device/token` with the
 * secret, exactly like a web-confirmed code.
 */
export async function redeemPairingCode(
  deps: DeviceDeps,
  userCode: string,
  input: RedeemPairingCodeInput,
  requester: DeviceRequester,
): Promise<RedeemedPairingCode> {
  if (input.protocol !== undefined && input.protocol < MIN_RUNNER_PROTOCOL) {
    throw new ValidationError("This runner is too old. Download the latest one.", "machine.outdated");
  }
  const now = nowOf(deps);
  const code = normalizeUserCode(userCode);
  if (code.length !== USER_CODE_LENGTH) throw notFound();
  const [row] = await deps.db
    .select()
    .from(machineDeviceCodes)
    .where(
      and(
        eq(machineDeviceCodes.userCode, code),
        eq(machineDeviceCodes.issuedVia, "chat"),
        eq(machineDeviceCodes.status, "confirmed"),
        isNull(machineDeviceCodes.machineId),
        gt(machineDeviceCodes.expiresAt, now),
      ),
    )
    .orderBy(machineDeviceCodes.createdAt)
    .limit(1);
  if (!row?.orgId || !row.confirmedByUserId) throw notFound();
  // Narrowed once here: property narrowing does not survive into the transaction's closure.
  const orgId = row.orgId;
  const minterId = row.confirmedByUserId;
  const targetAgentId = row.targetAgentId;
  const [org] = await deps.db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) throw notFound();
  const [target] = targetAgentId
    ? await deps.db
        .select()
        .from(agents)
        .where(and(eq(agents.id, targetAgentId), eq(agents.orgId, orgId)))
    : [];
  // The polling secret: fresh random bytes, whose hash replaces the placeholder the mint stored.
  const deviceCode = randomBytes(32).toString("base64url");
  const ip = requester.ip.slice(0, 100);
  const claimed = await deps.db.transaction(async (tx) => {
    const name = cleanMachineName(input.name) || input.hostname.slice(0, 80) || "Computer";
    const [machine] = await tx
      .insert(machines)
      .values({
        orgId,
        kind: "connected",
        name,
        pairedByUserId: minterId,
        hostname: input.hostname.slice(0, 200),
        os: OSES.find((o) => o === input.os) ?? "other",
        arch: input.arch.slice(0, 40),
        runnerVersion: input.version.slice(0, 40),
        ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
        ...(input.workspace !== undefined ? { workspace: input.workspace.slice(0, 500) } : {}),
        ...(input.exec !== undefined ? { execAllowed: input.exec } : {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!machine) throw new Error("machine insert returned nothing");
    const [codeRow] = await tx
      .update(machineDeviceCodes)
      .set({
        deviceCodeHash: sha256Hex(deviceCode),
        machineId: machine.id,
        name: cleanMachineName(input.name),
        os: OSES.find((o) => o === input.os) ?? "other",
        arch: input.arch.slice(0, 40),
        hostname: input.hostname.slice(0, 200),
        runnerVersion: input.version.slice(0, 40),
        ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
        ...(input.workspace !== undefined ? { workspace: input.workspace.slice(0, 500) } : {}),
        ...(input.exec !== undefined ? { execAllowed: input.exec } : {}),
        requesterIp: ip,
        approxLocation: requester.approxLocation?.slice(0, 120) || null,
      })
      .where(
        and(
          eq(machineDeviceCodes.id, row.id),
          eq(machineDeviceCodes.status, "confirmed"),
          isNull(machineDeviceCodes.machineId),
        ),
      )
      .returning({ id: machineDeviceCodes.id });
    // Another redeem claimed it first: the machine above rolls back with this.
    if (!codeRow) throw new Error("pairing code already redeemed");
    let assigned: { id: string; name: string } | null = null;
    let skipped: PairingAssignmentSkipped | null = null;
    if (targetAgentId) {
      const [agent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, targetAgentId), eq(agents.orgId, orgId)));
      if (!agent) skipped = "agent_not_found";
      else if (agent.archivedAt) skipped = "agent_archived";
      else if (isRightHand(agent)) skipped = "agent_right_hand";
      else if (agent.machineId) skipped = "agent_has_machine";
      else if (!mayBeHome({ kind: "connected" })) skipped = "agent_not_home";
      else {
        const [moved] = await tx
          .update(agents)
          .set({ machineId: machine.id, updatedAt: now })
          .where(
            and(eq(agents.id, agent.id), eq(agents.orgId, orgId), isNull(agents.machineId), isNull(agents.archivedAt)),
          )
          .returning({ id: agents.id, name: agents.name });
        if (moved) assigned = moved;
        else skipped = "agent_has_machine";
      }
    }
    return { machine, assigned, skipped };
  });
  const { machine, assigned, skipped } = claimed;
  const where = {
    name: machine.name,
    hostname: machine.hostname,
    os: machine.os,
    arch: machine.arch,
    ip,
    ...(requester.approxLocation ? { location: requester.approxLocation } : {}),
  };
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: minterId },
    action: "machine.connected",
    target: { type: "machine", id: machine.id },
    details: where,
  });
  if (assigned) {
    caches.agents.delete(`${orgId}:${assigned.id}`);
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: minterId },
      action: "agent.computer_target",
      target: { type: "agent", id: assigned.id },
      details: { from: null, to: machine.id, name: machine.name },
    });
    await publishOrgEvent(deps.pubsub, {
      type: "org.broadcast",
      orgId,
      event: {
        type: "agent.computer",
        agentId: assigned.id,
        target: { kind: "machine", machineId: machine.id, name: machine.name, online: false },
      },
    });
    await publishMachineAgentsChanged(deps.pubsub, orgId);
  }
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "machine.paired", machineId: machine.id, name: machine.name },
  });
  await notifyMachineConnected(deps, machine, minterId).catch(() => undefined);
  return {
    deviceCode,
    userCode: row.userCode,
    machineId: machine.id,
    org: { id: org.id, name: org.name },
    targetAgent: target ? { id: target.id, name: target.name } : null,
    assignedAgent: assigned,
    assignmentSkipped: skipped,
    expiresIn: Math.max(0, Math.floor((row.expiresAt.getTime() - now.getTime()) / 1000)),
    interval: DEVICE_POLL_INTERVAL_S,
  };
}
