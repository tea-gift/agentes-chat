import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/**
 * Deleting one message, and clearing a whole DM, over HTTP: the endpoints, the
 * statuses, and who may do it. A DM is between people here (no agent run is
 * triggered by posting); an agent DM is covered by clearing it empty.
 */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

type Posted = { id: string; body: string };
type Dm = { channelId: string };
type Listed = { messages: Posted[] };

/** An owner with Acme, its #general and the agent @dev; `api` calls the workspace's routes as the owner. */
async function start(options: Parameters<typeof createTestServer>[0] = {}) {
  t = await createTestServer(options);
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const api = (path: string, init?: Parameters<Browser>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return { owner, api, ...seeded };
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

/** A DM between the owner and Bia, with two messages in it. */
async function withDm() {
  const s = await start({ env: { ALLOW_SIGNUP: "true" } });
  const { owner, api, orgId } = s;
  await joinByInvitation(t, owner, orgId, "bia@example.com");
  const [biaUser] = await t.db.select().from(schema.users).where(eq(schema.users.email, "bia@example.com"));
  const dm = (await (
    await owner(`/api/app/organizations/${orgId}/dms`, { json: { userId: biaUser?.id } })
  ).json()) as Dm;
  const post = async (body: string) => {
    const res = await api(`/channels/${dm.channelId}/messages`, { json: { body } });
    expect(res.status).toBe(201);
    return (await res.json()) as Posted;
  };
  const listed = async () => ((await (await api(`/channels/${dm.channelId}/messages`)).json()) as Listed).messages;
  const first = await post("one");
  const second = await post("two");
  return { ...s, dm, post, listed, first, second };
}

describe("DELETE one message of a DM", () => {
  test("a participant deletes it: gone from the conversation; deleting it again is 404", async () => {
    const { api, dm, listed, first, second } = await withDm();
    const gone = await api(`/channels/${dm.channelId}/messages/${first.id}`, { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect((await listed()).map((m) => m.id)).toEqual([second.id]);

    const again = await api(`/channels/${dm.channelId}/messages/${first.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  test("a message of another conversation can't be deleted through this DM", async () => {
    const { api, dm, channelId } = await withDm();
    const elsewhere = (await (
      await api(`/channels/${channelId}/messages`, { json: { body: "elsewhere" } })
    ).json()) as Posted;
    const res = await api(`/channels/${dm.channelId}/messages/${elsewhere.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    // Still there, in its own conversation.
    const still = ((await (await api(`/channels/${channelId}/messages`)).json()) as Listed).messages;
    expect(still.map((m) => m.id)).toContain(elsewhere.id);
  });

  test("who is not in the DM gets 404; a channel is not a DM and gets 400", async () => {
    const { owner, api, orgId, dm, first, channelId } = await withDm();
    const cleo = await joinByInvitation(t, owner, orgId, "cleo@example.com");
    const refused = await cleo(`/api/app/organizations/${orgId}/channels/${dm.channelId}/messages/${first.id}`, {
      method: "DELETE",
    });
    expect(refused.status).toBe(404);

    const channel = await api(`/channels/${channelId}/messages/${first.id}`, { method: "DELETE" });
    expect(channel.status).toBe(400);
    expect(await errorCode(channel)).toBe("dm.not_dm");
  });
});

describe("DELETE a whole DM's messages", () => {
  test("every message goes, the count comes back, the DM takes new messages after", async () => {
    const { api, dm, post, listed } = await withDm();
    const cleared = await api(`/channels/${dm.channelId}/messages`, { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ deleted: 2 });
    expect(await listed()).toEqual([]);

    const again = await post("after");
    expect((await listed()).map((m) => m.id)).toEqual([again.id]);

    const clearedAgain = await api(`/channels/${dm.channelId}/messages`, { method: "DELETE" });
    expect(clearedAgain.status).toBe(200);
    expect(await clearedAgain.json()).toEqual({ deleted: 1 });
    expect(await listed()).toEqual([]);

    const empty = await api(`/channels/${dm.channelId}/messages`, { method: "DELETE" });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ deleted: 0 });
  });

  test("who is not in the DM gets 404; a channel is not a DM and gets 400", async () => {
    const { owner, api, orgId, dm, listed, channelId } = await withDm();
    const cleo = await joinByInvitation(t, owner, orgId, "cleo@example.com");
    const refused = await cleo(`/api/app/organizations/${orgId}/channels/${dm.channelId}/messages`, {
      method: "DELETE",
    });
    expect(refused.status).toBe(404);
    expect((await listed()).length).toBe(2);

    const channel = await api(`/channels/${channelId}/messages`, { method: "DELETE" });
    expect(channel.status).toBe(400);
    expect(await errorCode(channel)).toBe("dm.not_dm");
  });

  test("an agent DM clears too (empty: nothing to delete, no run is started)", async () => {
    const { owner, api, orgId, agentId } = await start({ env: { ALLOW_SIGNUP: "true" } });
    const dm = (await (await owner(`/api/app/organizations/${orgId}/dms`, { json: { agentId } })).json()) as Dm;
    const cleared = await api(`/channels/${dm.channelId}/messages`, { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ deleted: 0 });
  });
});
