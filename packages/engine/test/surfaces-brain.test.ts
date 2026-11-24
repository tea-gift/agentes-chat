import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  answerSurfaceBrainRequest,
  createNtfyBrainLink,
  insertMessage,
  openPersonAgentDm,
  pollSurfaceBrainTopics,
  queueSurfaceBrainRequest,
  surfaceBrainLinkForRun,
} from "../src";
import { addUser, type Fixture, setup } from "./fixtures";

const { agentRuns, surfaceDeliveries, surfaceLinks } = schema;

let f: Fixture;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  f = await setup({ rightHand: true });
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await f.close();
});

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

/** A brain link for the Dev agent, over a fake ntfy server. */
const brainLink = (server = "https://ntfy.example.com", topic = "muse-brain-dev") =>
  createNtfyBrainLink({ db: f.db }, f.owner.id, f.agent.id, server, topic);

/** The owner's DM with the Dev agent, with one message from the owner in it. */
async function dmWithMessage(body = "Hello, Dev") {
  const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id);
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "person", userId: f.owner.id },
    body,
  });
  return { dm, trigger };
}

/** A run of the Dev agent on the trigger, in `status`. */
async function runOn(
  trigger: { id: string; channelId: string },
  status: "running" | "waiting_input" | "done" = "running",
) {
  const [run] = await f.db
    .insert(agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: trigger.channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "dm",
      hop: 1,
      status,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

/** A fetch stub that records its calls and answers from `respond`. */
function stubFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return calls;
}

const ok = () => new Response(null, { status: 200 });

describe("a brain link over ntfy", () => {
  test("names its server and topic, is active at once, and replaces the agent's old brain link", async () => {
    const first = await brainLink("https://ntfy.example.com/", "muse-brain-dev");
    expect(first).toMatchObject({
      surface: "ntfy",
      externalId: "muse-brain-dev",
      status: "active",
      agentId: f.agent.id,
      brain: true,
      ntfyServer: "https://ntfy.example.com",
      ntfyTopic: "muse-brain-dev",
    });
    const second = await brainLink("https://ntfy.example.com", "muse-brain-dev-2");
    // The old brain link is replaced, not kept: one active link per surface and agent.
    const rows = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.agentId, f.agent.id));
    expect(rows.map((r) => [r.id, r.brain])).toEqual([[second.id, true]]);
  });

  test("refuses a server that isn't an http(s) URL and a topic that isn't a topic", async () => {
    expect(await errorOf(brainLink("not a url", "ok-topic"))).toBe("surface.brain_bad_server");
    expect(await errorOf(brainLink("ftp://ntfy.example.com", "ok-topic"))).toBe("surface.brain_bad_server");
    expect(await errorOf(brainLink("https://ntfy.example.com", "has/slash"))).toBe("surface.brain_bad_topic");
    expect(await errorOf(brainLink("https://ntfy.example.com", ""))).toBe("surface.brain_bad_topic");
    expect(await errorOf(brainLink("https://ntfy.example.com", "x".repeat(65)))).toBe("surface.brain_bad_topic");
  });

  test("refuses an agent that is gone or in a workspace the person isn't in", async () => {
    expect(
      await errorOf(createNtfyBrainLink({ db: f.db }, f.owner.id, Bun.randomUUIDv7(), "https://ntfy.example.com", "t")),
    ).toBe("surface.brain_no_agent");
    const outsider = await addUser(f.db, "outsider");
    expect(
      await errorOf(createNtfyBrainLink({ db: f.db }, outsider.id, f.agent.id, "https://ntfy.example.com", "t")),
    ).toBe("surface.brain_not_member");
  });
});

describe("a run's brain link", () => {
  test("is the brain link for a DM run the person started", async () => {
    const link = await brainLink();
    const { trigger } = await dmWithMessage();
    const run = await runOn(trigger);
    expect(await surfaceBrainLinkForRun(f.db, run, f.agent)).toMatchObject({ id: link.id });
    expect(await surfaceBrainLinkForRun(f.db, { ...run, channelId: f.general.id }, f.agent)).toBeNull();
  });

  test("is null with no brain link", async () => {
    const { trigger } = await dmWithMessage();
    const run = await runOn(trigger);
    expect(await surfaceBrainLinkForRun(f.db, run, f.agent)).toBeNull();
  });
});

describe("asking the linked Muse", () => {
  test("posts the conversation to the topic and records the pending request", async () => {
    const link = await brainLink();
    const calls = stubFetch(() => ok());
    const { trigger } = await dmWithMessage("What is 2+2?");
    const run = await runOn(trigger);
    const delivery = await queueSurfaceBrainRequest({ db: f.db }, run, link);
    if (!delivery) throw new Error("no delivery");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call?.init) throw new Error("no fetch call");
    expect(call.url).toBe("https://ntfy.example.com/muse-brain-dev");
    expect((call.init.headers as Record<string, string>).Title).toBe(`[brain-request ${delivery.id}]`);
    expect(call.init.body).toContain("What is 2+2?");
    const [row] = await f.db
      .select()
      .from(surfaceDeliveries)
      .where(eq(surfaceDeliveries.id, delivery?.id ?? ""));
    expect(row).toMatchObject({ kind: "brain_request", runId: run.id, linkId: link.id });
    // Asking again while it waits posts nothing new.
    expect(await queueSurfaceBrainRequest({ db: f.db }, run, link)).toMatchObject({ id: delivery?.id });
    expect(calls).toHaveLength(1);
  });

  test("posts nothing and records nothing when the topic is unreachable", async () => {
    const link = await brainLink();
    stubFetch(() => {
      throw new Error("down");
    });
    const { trigger } = await dmWithMessage();
    const run = await runOn(trigger);
    expect(await queueSurfaceBrainRequest({ db: f.db }, run, link)).toBeNull();
    expect(await f.db.select().from(surfaceDeliveries)).toHaveLength(0);
  });

  test("posts nothing when the link has no topic", async () => {
    // A link paired the usual way, marked as the brain: no topic to post to.
    const [paired] = await f.db
      .insert(surfaceLinks)
      .values({
        userId: f.owner.id,
        surface: "example chat",
        externalId: "sender-1",
        status: "active",
        orgId: f.org.id,
        agentId: f.agent.id,
        brain: true,
      })
      .returning();
    if (!paired) throw new Error("no link");
    const calls = stubFetch(() => ok());
    const { trigger } = await dmWithMessage();
    const run = await runOn(trigger);
    expect(await queueSurfaceBrainRequest({ db: f.db }, run, paired)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("the linked Muse's reply", () => {
  async function asked() {
    const link = await brainLink();
    stubFetch(() => ok());
    const { trigger } = await dmWithMessage("What is 2+2?");
    const run = await runOn(trigger);
    const delivery = await queueSurfaceBrainRequest({ db: f.db }, run, link);
    if (!delivery) throw new Error("no delivery");
    await f.db.update(agentRuns).set({ status: "waiting_input" }).where(eq(agentRuns.id, run.id));
    return { link, run, delivery };
  }

  test("is stored on the parked run, closes the request, and queues the run again", async () => {
    const { run, delivery } = await asked();
    const done = await answerSurfaceBrainRequest({ db: f.db }, delivery.id, "Four.");
    expect(done).toEqual({ status: "answered", runId: run.id });
    const [row] = await f.db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    if (!row) throw new Error("no run");
    expect((row.transcript as { surfaceBrainReply?: { text: string } }).surfaceBrainReply?.text).toBe("Four.");
    const [closed] = await f.db.select().from(surfaceDeliveries).where(eq(surfaceDeliveries.id, delivery.id));
    if (!closed) throw new Error("no delivery");
    expect(closed.takenAt).not.toBeNull();
    expect(closed.outcome).toBe("sent");
  });

  test("is late when the run already moved on, and an empty reply is refused", async () => {
    const { run, delivery } = await asked();
    await f.db.update(agentRuns).set({ status: "done" }).where(eq(agentRuns.id, run.id));
    expect(await answerSurfaceBrainRequest({ db: f.db }, delivery.id, "Four.")).toEqual({
      status: "late",
      runId: run.id,
    });
    expect(await errorOf(answerSurfaceBrainRequest({ db: f.db }, delivery.id, "Four."))).toBe(
      "surface.brain_request_gone",
    );
    const { delivery: second } = await asked();
    expect(await errorOf(answerSurfaceBrainRequest({ db: f.db }, second.id, "   "))).toBe("surface.brain_empty");
    expect(await errorOf(answerSurfaceBrainRequest({ db: f.db }, Bun.randomUUIDv7(), "Four."))).toBe(
      "surface.brain_request_gone",
    );
  });
});

describe("reading replies from the topics", () => {
  test("answers a brain-reply message and ignores requests and other titles", async () => {
    const link = await brainLink();
    stubFetch(() => ok());
    const { trigger } = await dmWithMessage("What is 2+2?");
    const run = await runOn(trigger);
    const delivery = await queueSurfaceBrainRequest({ db: f.db }, run, link);
    if (!delivery) throw new Error("no delivery");
    await f.db.update(agentRuns).set({ status: "waiting_input" }).where(eq(agentRuns.id, run.id));
    const lines = [
      { id: "m1", title: `[brain-request ${delivery.id}]`, message: "the request, already posted" },
      { id: "m2", title: `[brain-reply ${delivery.id}]`, message: "Four." },
      { id: "m3", title: "hello", message: "not a brain message" },
    ];
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n"), { status: 200 });
    });
    expect(await pollSurfaceBrainTopics({ db: f.db })).toBe(1);
    expect(seen[0]).toContain("/muse-brain-dev/json?poll=1&since=5m");
    const [row] = await f.db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    if (!row) throw new Error("no run");
    expect((row.transcript as { surfaceBrainReply?: { text: string } }).surfaceBrainReply?.text).toBe("Four.");
    // A second poll reads past the reply: nothing new to answer. It resumes after the last message seen (m3).
    expect(await pollSurfaceBrainTopics({ db: f.db })).toBe(0);
    expect(seen[1]).toContain("since=m3");
  });

  test("skips a topic whose server is down and still reads the others", async () => {
    await brainLink("https://down.example.com", "brain-down");
    const link = await brainLink("https://ntfy.example.com", "brain-up");
    stubFetch((url) => {
      if (url.startsWith("https://down.example.com")) throw new Error("down");
      return new Response("", { status: 200 });
    });
    expect(await pollSurfaceBrainTopics({ db: f.db })).toBe(0);
    expect(link.ntfyTopic).toBe("brain-up");
  });
});
