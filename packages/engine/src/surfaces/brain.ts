import { and, type Database, desc, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { pgSafeJson } from "../format";
import { getMembership } from "../organizations";
import { enqueue } from "../outbox";
import { isRightHand } from "../right-hand";
import type { AgentRun } from "../runs";
import { SURFACE_FALLBACK_JOB } from "./config";
import { agentForLink, type SurfaceLinkRow } from "./links";

const { surfaceDeliveries, surfaceLinks, messages, channels, agents, users } = schema;

/**
 * How long a brain request stays open for the linked sender to answer: a
 * sender that polls on its own schedule (another Muse, every 30 minutes)
 * needs a full cycle plus time to write. Past it the run fails and says so.
 */
export const SURFACE_BRAIN_WAIT_MS = 60 * 60_000;
/** A brain request's payload stays small enough for the service that carries it (ntfy caps a message near 4 KiB). */
export const SURFACE_BRAIN_TEXT_MAX = 3500;
/** How many of the DM's messages the request carries (the latest ones). */
const SURFACE_BRAIN_HISTORY = 12;
/** How long the topic poller waits on ntfy before giving up on one topic (a slow server must not hold the rest). */
const SURFACE_BRAIN_NTFY_TIMEOUT_MS = 10_000;
/** A topic the poller never read: how far back it looks for a reply on its first pass. */
const SURFACE_BRAIN_POLL_BACKFILL = "5m";

/** The reply a linked sender wrote for a parked run, kept on its transcript until the run posts it. */
export interface SurfaceBrainReply {
  deliveryId: string;
  text: string;
  at: string;
}

/** The title of a brain request posted to the topic, carrying the delivery it asks about. */
export const brainRequestTitle = (deliveryId: string) => `[brain-request ${deliveryId}]`;
/** The title of a brain reply posted to the topic, carrying the delivery it answers. */
export const brainReplyTitle = (deliveryId: string) => `[brain-reply ${deliveryId}]`;
const BRAIN_REPLY_PREFIX = "[brain-reply ";

/** The ntfy topic's URL, from the server and topic the brain link names. */
export const ntfyTopicUrl = (server: string, topic: string) =>
  `${server.replace(/\/+$/, "")}/${topic.replace(/^\/+/, "")}`;

/**
 * A brain link is a ntfy channel, not a paired surface link: its server and
 * topic are the connection, and the topic name is the shared secret. A link
 * without a topic can't be a brain (a paired link has none): it is skipped.
 */
export const hasBrainTopic = (
  link: SurfaceLinkRow,
): link is SurfaceLinkRow & { ntfyServer: string; ntfyTopic: string } =>
  typeof link.ntfyServer === "string" &&
  link.ntfyServer.length > 0 &&
  typeof link.ntfyTopic === "string" &&
  link.ntfyTopic.length > 0;

/**
 * The agent's brain link: an active link of this person for this agent,
 * marked as its brain. The right hand's link names no agent. A link with a
 * topic wins over one without (only it can be posted to). Null when there is
 * no such link.
 */
export async function surfaceBrainLink(
  db: Executor,
  orgId: string,
  userId: string,
  agent: { id: string; builtin?: string | null },
): Promise<SurfaceLinkRow | null> {
  const agentId = isRightHand(agent) ? null : agent.id;
  const rows = await db
    .select()
    .from(surfaceLinks)
    .where(
      and(
        eq(surfaceLinks.userId, userId),
        eq(surfaceLinks.orgId, orgId),
        eq(surfaceLinks.status, "active"),
        eq(surfaceLinks.brain, true),
        agentId ? eq(surfaceLinks.agentId, agentId) : isNull(surfaceLinks.agentId),
      ),
    )
    .orderBy(desc(surfaceLinks.createdAt));
  return rows.find((row) => hasBrainTopic(row)) ?? rows[0] ?? null;
}

/**
 * The brain link behind a run: only a DM conversation run, started by a
 * person, whose thread isn't confidential (ADR 0190: its words stay with one
 * provider, never an outside sender). Anything else keeps its own brain.
 */
export async function surfaceBrainLinkForRun(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "agentId" | "channelId" | "triggerMessageId" | "threadRootId">,
  agent: { id: string; builtin?: string | null },
): Promise<SurfaceLinkRow | null> {
  const [channel] = await db
    .select({ kind: channels.kind })
    .from(channels)
    .where(and(eq(channels.id, run.channelId), eq(channels.orgId, run.orgId)));
  if (channel?.kind !== "dm") return null;
  if (run.threadRootId) {
    const [sealed] = await db
      .select({ id: schema.confidentialThreads.rootMessageId })
      .from(schema.confidentialThreads)
      .where(
        and(
          eq(schema.confidentialThreads.orgId, run.orgId),
          eq(schema.confidentialThreads.rootMessageId, run.threadRootId),
        ),
      );
    if (sealed) return null;
  }
  const [trigger] = await db
    .select({ userId: messages.authorUserId })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.id, run.triggerMessageId),
        eq(messages.authorType, "person"),
        isNull(messages.deletedAt),
      ),
    );
  if (!trigger?.userId) return null;
  return surfaceBrainLink(db, run.orgId, trigger.userId, agent);
}

/** The conversation the brain request carries: the DM's latest messages, newest last, as the sender reads them. */
export async function brainRequestText(
  db: Executor,
  orgId: string,
  channelId: string,
  agentName: string,
  personName: string,
): Promise<string> {
  const rows = await db
    .select({
      id: messages.id,
      createdAt: messages.createdAt,
      authorType: messages.authorType,
      authorAgentId: messages.authorAgentId,
      body: messages.body,
    })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.channelId, channelId),
        isNull(messages.threadId),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(SURFACE_BRAIN_HISTORY);
  const lines = [...rows]
    .reverse()
    .map((m) => {
      const who = m.authorType === "agent" ? agentName : personName;
      const body = (m.body ?? "").trim().replace(/\s+/g, " ");
      return `${who}: ${body}`;
    })
    .filter((line) => !line.endsWith(": "));
  const head = `# Reply as ${agentName} (in ${personName}'s DM with ${agentName})\nThe conversation so far:\n`;
  const tail = `\nWrite ${agentName}'s reply to the last message. Reply with only the reply text.`;
  let text = head + lines.join("\n") + tail;
  if (text.length > SURFACE_BRAIN_TEXT_MAX) {
    // Keep the newest lines whole: drop the oldest until it fits.
    const kept = [...lines];
    while (kept.length > 1 && (head + kept.join("\n") + tail).length > SURFACE_BRAIN_TEXT_MAX) kept.shift();
    text = head + kept.join("\n") + tail;
    if (text.length > SURFACE_BRAIN_TEXT_MAX) text = text.slice(0, SURFACE_BRAIN_TEXT_MAX);
  }
  return text;
}

/** The open brain request of a run, if one is already waiting for its sender. Exported: the executor re-parks a run whose request is still open. */
export async function openBrainRequest(db: Executor, runId: string) {
  const [row] = await db
    .select()
    .from(surfaceDeliveries)
    .where(
      and(
        eq(surfaceDeliveries.runId, runId),
        eq(surfaceDeliveries.kind, "brain_request"),
        isNull(surfaceDeliveries.takenAt),
      ),
    );
  return row ?? null;
}

/** The most recent brain request of a run, open or closed. A closed one with no reply stored means it timed out. */
export async function lastBrainRequest(db: Executor, runId: string) {
  const [row] = await db
    .select()
    .from(surfaceDeliveries)
    .where(and(eq(surfaceDeliveries.runId, runId), eq(surfaceDeliveries.kind, "brain_request")))
    .orderBy(desc(surfaceDeliveries.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Ask the link's sender to write this run's reply: the conversation is
 * POSTed to the link's ntfy topic (the topic is the transport, the delivery
 * row the shell's record of the pending request, with its fallback job at
 * `SURFACE_BRAIN_WAIT_MS`). A run that already asked gets its open request
 * back instead of a second one. Null when the link has no topic to post to,
 * or the post failed: the run fails instead of parking on a request nobody
 * got. The post goes first, so a failure leaves no row and no job behind.
 */
export async function queueSurfaceBrainRequest(
  deps: { db: Database },
  run: Pick<AgentRun, "id" | "orgId" | "channelId" | "triggerMessageId">,
  link: SurfaceLinkRow,
) {
  const { db } = deps;
  const existing = await openBrainRequest(db, run.id);
  if (existing) return existing;
  if (!hasBrainTopic(link)) return null;
  const agent = await agentForLink(db, link);
  if (!agent) return null;
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, link.userId));
  const text = await brainRequestText(db, run.orgId, run.channelId, agent.name, person?.name ?? "the person");
  const deliveryId = Bun.randomUUIDv7();
  let posted = false;
  try {
    const res = await fetch(ntfyTopicUrl(link.ntfyServer, link.ntfyTopic), {
      method: "POST",
      headers: { Title: brainRequestTitle(deliveryId) },
      body: text,
      signal: AbortSignal.timeout(SURFACE_BRAIN_NTFY_TIMEOUT_MS),
    });
    posted = res.ok;
  } catch {
    posted = false;
  }
  if (!posted) return null;
  const [row] = await db
    .insert(surfaceDeliveries)
    .values({
      id: deliveryId,
      orgId: run.orgId,
      linkId: link.id,
      kind: "brain_request",
      runId: run.id,
      inReplyTo: run.triggerMessageId,
    })
    .returning();
  if (!row) return null;
  await enqueue(db, {
    orgId: run.orgId,
    kind: SURFACE_FALLBACK_JOB,
    payload: { deliveryId: row.id },
    runAt: new Date(Date.now() + SURFACE_BRAIN_WAIT_MS),
    dedupeKey: `surface.fallback:${row.id}`,
  });
  return row;
}

/**
 * The sender's reply to a brain request: stored on the run for its turn to
 * post as the agent's message, the delivery closed as sent, and the run
 * queued again. `surface.brain_request_gone` when the request is unknown or
 * already closed; `late` when the run already moved on (the reply is dropped).
 */
export async function answerSurfaceBrainRequest(
  deps: { db: Database },
  deliveryId: string,
  text: string,
): Promise<{ status: "answered" | "late"; runId: string }> {
  const { db } = deps;
  const trimmed = text.trim();
  if (!trimmed) throw new ValidationError("Write a reply", "surface.brain_empty");
  const [delivery] = await db
    .select()
    .from(surfaceDeliveries)
    .where(
      and(
        eq(surfaceDeliveries.id, deliveryId),
        eq(surfaceDeliveries.kind, "brain_request"),
        isNull(surfaceDeliveries.takenAt),
      ),
    );
  if (!delivery?.runId || !delivery.linkId) {
    throw new NotFoundError("This brain request is unknown or already answered", "surface.brain_request_gone");
  }
  const runId = delivery.runId;
  const [link] = await db
    .select()
    .from(surfaceLinks)
    .where(and(eq(surfaceLinks.id, delivery.linkId), eq(surfaceLinks.status, "active")));
  if (!link || link.orgId !== delivery.orgId) {
    throw new NotFoundError("This brain request is unknown or already answered", "surface.brain_request_gone");
  }
  const closed = await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.orgId, delivery.orgId)))
      .for("update");
    if (!run) return null;
    const late = run.status !== "waiting_input";
    const [closedRow] = await tx
      .update(surfaceDeliveries)
      .set({ takenAt: new Date(), outcome: late ? "dropped" : "sent" })
      .where(and(eq(surfaceDeliveries.id, delivery.id), isNull(surfaceDeliveries.takenAt)))
      .returning({ id: surfaceDeliveries.id });
    if (!closedRow) return null;
    if (late) return { late: true as const, runId: run.id };
    const t = (run.transcript ?? {}) as Record<string, unknown>;
    const reply: SurfaceBrainReply = { deliveryId: delivery.id, text: trimmed, at: new Date().toISOString() };
    await tx
      .update(schema.agentRuns)
      .set({
        transcript: pgSafeJson({ ...t, surfaceBrainReply: reply }) as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentRuns.id, run.id));
    await enqueue(tx, {
      orgId: run.orgId,
      kind: "agent_run.execute",
      payload: { runId: run.id },
      dedupeKey: `agent_run.execute:${run.id}:brain:${delivery.id}`,
      maxAttempts: 4,
    });
    return { late: false as const, runId: run.id };
  });
  if (!closed)
    throw new NotFoundError("This brain request is unknown or already answered", "surface.brain_request_gone");
  return closed.late ? { status: "late", runId: closed.runId } : { status: "answered", runId: closed.runId };
}

/** Where the topic poller left off on each brain topic (an ntfy message id): kept in memory, a restart looks back a few minutes. */
const brainTopicSince = new Map<string, string>();

/**
 * The replies the linked senders posted to their topics since the last poll:
 * each `[brain-reply <delivery>]` message is answered on its run (a reply to
 * a request already closed comes back `late` and is dropped). Returns how
 * many runs were woken. A topic that fails (its server down, a bad topic) is
 * skipped and tried again next poll; the request's fallback still fails its
 * run in time.
 */
export async function pollSurfaceBrainTopics(deps: { db: Database }): Promise<number> {
  const links = await deps.db
    .select()
    .from(surfaceLinks)
    .where(and(eq(surfaceLinks.status, "active"), eq(surfaceLinks.brain, true)));
  let answered = 0;
  for (const link of links) {
    if (!hasBrainTopic(link)) continue;
    const key = `${link.ntfyServer}|${link.ntfyTopic}`;
    const since = brainTopicSince.get(key) ?? SURFACE_BRAIN_POLL_BACKFILL;
    let res: Response;
    try {
      res = await fetch(
        `${ntfyTopicUrl(link.ntfyServer, link.ntfyTopic)}/json?poll=1&since=${encodeURIComponent(since)}`,
        {
          signal: AbortSignal.timeout(SURFACE_BRAIN_NTFY_TIMEOUT_MS),
        },
      );
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const lines = (await res.text()).split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      let msg: { id?: unknown; title?: unknown; message?: unknown };
      try {
        msg = JSON.parse(line) as { id?: unknown; title?: unknown; message?: unknown };
      } catch {
        continue;
      }
      if (typeof msg.id === "string") brainTopicSince.set(key, msg.id);
      if (typeof msg.title !== "string" || typeof msg.message !== "string") continue;
      if (!msg.title.startsWith(BRAIN_REPLY_PREFIX) || !msg.title.endsWith("]")) continue;
      const deliveryId = msg.title.slice(BRAIN_REPLY_PREFIX.length, -1);
      if (!deliveryId) continue;
      try {
        const done = await answerSurfaceBrainRequest(deps, deliveryId, msg.message);
        if (done.status === "answered") answered++;
      } catch {
        // Unknown or already answered: a stale reply, or one for another link's topic. Dropped.
      }
    }
  }
  return answered;
}

/**
 * Connect a Muse as an agent's brain by naming its ntfy channel: the server
 * the brain request is POSTed to and the topic the reply is read from. No
 * pairing code: the topic name is the shared secret, and the link is active
 * at once. Only one active brain link per (account, agent): making one
 * clears the agent's other brain link. The agent must be in a workspace the
 * person belongs to.
 */
export async function createNtfyBrainLink(
  deps: { db: Database },
  userId: string,
  agentId: string,
  server: string,
  topic: string,
): Promise<SurfaceLinkRow> {
  const { db } = deps;
  const normalizedServer = server.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(normalizedServer);
  } catch {
    throw new ValidationError("The server is a URL like https://ntfy.sh", "surface.brain_bad_server");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("The server is a URL like https://ntfy.sh", "surface.brain_bad_server");
  }
  const normalizedTopic = topic.trim();
  if (!/^[-A-Za-z0-9_]{1,64}$/.test(normalizedTopic)) {
    throw new ValidationError("The topic is letters, numbers, - and _ (up to 64)", "surface.brain_bad_topic");
  }
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw new NotFoundError("This assistant is gone", "surface.brain_no_agent");
  if (!agent.orgId || !(await getMembership(db, userId, agent.orgId))) {
    throw new ForbiddenError("This assistant isn't in a workspace of yours", "surface.brain_not_member");
  }
  return db.transaction(async (tx) => {
    // The agent's old brain link on ntfy is replaced (one active link per surface and agent, like a confirm).
    await tx
      .delete(surfaceLinks)
      .where(
        and(
          eq(surfaceLinks.userId, userId),
          eq(surfaceLinks.surface, "ntfy"),
          eq(surfaceLinks.status, "active"),
          eq(surfaceLinks.agentId, agentId),
        ),
      );
    // Any other surface's brain link for this agent stops being its brain: one brain per agent.
    await tx
      .update(surfaceLinks)
      .set({ brain: false })
      .where(
        and(
          eq(surfaceLinks.userId, userId),
          eq(surfaceLinks.status, "active"),
          eq(surfaceLinks.brain, true),
          eq(surfaceLinks.agentId, agentId),
        ),
      );
    const [row] = await tx
      .insert(surfaceLinks)
      .values({
        userId,
        surface: "ntfy",
        externalId: normalizedTopic,
        display: normalizedTopic,
        status: "active",
        orgId: agent.orgId,
        agentId,
        brain: true,
        ntfyServer: normalizedServer,
        ntfyTopic: normalizedTopic,
      })
      .returning();
    if (!row) throw new Error("surface brain link not written");
    return row;
  });
}
