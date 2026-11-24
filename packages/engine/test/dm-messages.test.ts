import { afterEach, describe, expect, test } from "bun:test";
import {
  clearDm,
  deleteDmMessage,
  listDms,
  listMessages,
  listPins,
  NotFoundError,
  openDm,
  pinMessage,
  postPersonMessage,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("deleting one message of a DM", () => {
  const deps = () => ({ db: f.db, pubsub: f.pubsub });
  const post = (userId: string, channelId: string, body: string) =>
    postPersonMessage(deps(), userId, f.org.id, channelId, { body });
  const listed = (userId: string, channelId: string) => listMessages(f.db, userId, f.org.id, channelId);
  const preview = async (userId: string, channelId: string) =>
    (await listDms(f.db, userId, f.org.id)).find((d) => d.channelId === channelId)?.lastMessage;

  async function withBia() {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    return { bia, dm };
  }

  test("a participant deletes a message: it leaves the conversation, its preview and its pin; the other one hears it", async () => {
    const { bia, dm } = await withBia();
    const events = f.listen(dm.id);
    const first = await post(f.owner.id, dm.id, "first");
    const second = await post(bia.id, dm.id, "second");
    await pinMessage(deps(), f.owner.id, f.org.id, dm.id, first.id);
    expect((await listed(f.owner.id, dm.id)).map((m) => m.id)).toEqual([first.id, second.id]);
    expect((await preview(f.owner.id, dm.id))?.id).toBe(second.id);

    expect(await deleteDmMessage(f.db, f.owner.id, f.org.id, dm.id, first.id, f.pubsub)).toEqual({
      deleted: true,
    });
    // Gone for both of us; the pin went with it.
    expect((await listed(f.owner.id, dm.id)).map((m) => m.id)).toEqual([second.id]);
    expect((await listed(bia.id, dm.id)).map((m) => m.id)).toEqual([second.id]);
    expect(await listPins(f.db, f.owner.id, f.org.id, dm.id)).toEqual([]);
    expect(events).toContainEqual({ type: "message.deleted", channelId: dm.id, messageId: first.id });
  });

  test("deleting the last message moves the preview to the one before it", async () => {
    const { bia, dm } = await withBia();
    const first = await post(f.owner.id, dm.id, "first");
    const second = await post(bia.id, dm.id, "second");
    await deleteDmMessage(f.db, bia.id, f.org.id, dm.id, second.id, f.pubsub);
    expect((await listed(bia.id, dm.id)).map((m) => m.id)).toEqual([first.id]);
    expect((await preview(bia.id, dm.id))?.id).toBe(first.id);
  });

  test("deleting twice is gone the second time; a message of another conversation is gone too", async () => {
    const { dm } = await withBia();
    const one = await post(f.owner.id, dm.id, "one");
    await deleteDmMessage(f.db, f.owner.id, f.org.id, dm.id, one.id, f.pubsub);
    await expect(deleteDmMessage(f.db, f.owner.id, f.org.id, dm.id, one.id, f.pubsub)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const elsewhere = await post(f.owner.id, f.general.id, "elsewhere");
    await expect(deleteDmMessage(f.db, f.owner.id, f.org.id, dm.id, elsewhere.id, f.pubsub)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("who is not in the DM can't delete from it", async () => {
    const { dm } = await withBia();
    const cleo = await addMember(f.db, f.org.id, "member", "cleo");
    const one = await post(f.owner.id, dm.id, "one");
    await expect(deleteDmMessage(f.db, cleo.id, f.org.id, dm.id, one.id, f.pubsub)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await listed(f.owner.id, dm.id)).map((m) => m.id)).toEqual([one.id]);
  });

  test("a channel is not a DM: deleting there is refused", async () => {
    f = await setup();
    const one = await post(f.owner.id, f.general.id, "one");
    await expect(deleteDmMessage(f.db, f.owner.id, f.org.id, f.general.id, one.id, f.pubsub)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await listed(f.owner.id, f.general.id)).map((m) => m.id)).toContain(one.id);
  });
});

describe("clearing a whole DM", () => {
  const deps = () => ({ db: f.db, pubsub: f.pubsub });
  const post = (userId: string, channelId: string, body: string) =>
    postPersonMessage(deps(), userId, f.org.id, channelId, { body });
  const listed = (userId: string, channelId: string) => listMessages(f.db, userId, f.org.id, channelId);

  async function withBia() {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    return { bia, dm };
  }

  test("every message goes, the count is returned, the DM stays, the other one hears it", async () => {
    const { bia, dm } = await withBia();
    const events = f.listen(dm.id);
    await post(f.owner.id, dm.id, "one");
    await post(bia.id, dm.id, "two");
    const pinned = await post(f.owner.id, dm.id, "three");
    await pinMessage(deps(), f.owner.id, f.org.id, dm.id, pinned.id);

    expect(await clearDm(f.db, f.owner.id, f.org.id, dm.id, f.pubsub)).toEqual({ deleted: 3 });
    expect(await listed(f.owner.id, dm.id)).toEqual([]);
    expect(await listed(bia.id, dm.id)).toEqual([]);
    expect(await listPins(f.db, f.owner.id, f.org.id, dm.id)).toEqual([]);
    expect(events).toContainEqual({ type: "dm.cleared", channelId: dm.id, deleted: 3 });
    // The conversation itself stays: a new message starts it again.
    const again = await post(bia.id, dm.id, "after");
    expect((await listed(f.owner.id, dm.id)).map((m) => m.id)).toEqual([again.id]);
  });

  test("clearing an empty DM deletes nothing", async () => {
    const { dm } = await withBia();
    expect(await clearDm(f.db, f.owner.id, f.org.id, dm.id, f.pubsub)).toEqual({ deleted: 0 });
  });

  test("who is not in the DM can't clear it", async () => {
    const { dm } = await withBia();
    const cleo = await addMember(f.db, f.org.id, "member", "cleo");
    await post(f.owner.id, dm.id, "one");
    await expect(clearDm(f.db, cleo.id, f.org.id, dm.id, f.pubsub)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listed(f.owner.id, dm.id)).length).toBe(1);
  });

  test("a channel is not a DM: clearing there is refused", async () => {
    f = await setup();
    await post(f.owner.id, f.general.id, "one");
    await expect(clearDm(f.db, f.owner.id, f.org.id, f.general.id, f.pubsub)).rejects.toBeInstanceOf(ValidationError);
    expect((await listed(f.owner.id, f.general.id)).length).toBe(1);
  });
});
