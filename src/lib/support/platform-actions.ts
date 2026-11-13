"use server";

import { z } from "zod";
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma, platformAdminTransaction } from "../db";
import { requirePlatformAdmin } from "../admin/session";
import { parseInput } from "../security/parse-input";
import { messageBodySchema, orderMessagesTag, type ThreadMessage } from "./thread";

const QUEUE_LIMIT = 100;

export type EscalatedThread = {
  id: string;
  storeName: string;
  storeTimezone: string;
  orderNumber: number;
  topic: string;
  state: string;
  escalationReason: string | null;
  escalatedAt: string;
  ageMinutes: number;
  waiting: boolean;
  seenAt: string | null;
  messages: (ThreadMessage & { senderName: string | null })[];
};

type QueueRow = Prisma.SupportThreadGetPayload<{ select: typeof QUEUE_SELECT }>;

const QUEUE_SELECT = {
  id: true,
  topic: true,
  state: true,
  escalationReason: true,
  escalatedAt: true,
  lastCustomerAt: true,
  lastReplyAt: true,
  store: { select: { name: true, timezone: true } },
  order: { select: { number: true } },
  messages: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, sender: true, body: true, createdAt: true, senderUser: { select: { name: true } } },
  },
} satisfies Prisma.SupportThreadSelect;

/**
 * Every store's escalated threads not yet resolved, waiting ones first, oldest escalation first.
 * Waiting means the newest message is the customer's (escalated, or no reply since it). A replied thread is `open` again and stays
 * listed until a platform admin resolves it. `hidden` counts the threads past the cap.
 */
export async function listEscalatedThreads(): Promise<{ threads: EscalatedThread[]; hidden: number }> {
  await requirePlatformAdmin();
  const { rows, total } = await platformAdminTransaction(async (tx) => {
    const listed = { escalatedAt: { not: null }, state: { not: "resolved" } } satisfies Prisma.SupportThreadWhereInput;
    const lastReplyAt = tx.supportThread.fields.lastReplyAt;
    const waiting = await tx.supportThread.findMany({
      where: { ...listed, OR: [{ state: "escalated" }, { lastReplyAt: null }, { lastCustomerAt: { gt: lastReplyAt } }] },
      orderBy: { escalatedAt: "asc" },
      take: QUEUE_LIMIT,
      select: QUEUE_SELECT,
    });
    const answered = waiting.length < QUEUE_LIMIT
      ? await tx.supportThread.findMany({
          where: {
            ...listed,
            state: "open",
            lastReplyAt: { not: null },
            OR: [{ lastCustomerAt: null }, { lastCustomerAt: { lte: lastReplyAt } }],
          },
          orderBy: { escalatedAt: "asc" },
          take: QUEUE_LIMIT - waiting.length,
          select: QUEUE_SELECT,
        })
      : [];
    return { rows: [...waiting, ...answered], total: await tx.supportThread.count({ where: listed }) };
  });
  const now = Date.now();
  const threads = rows.map((t: QueueRow) => ({
    id: t.id,
    storeName: t.store.name,
    storeTimezone: t.store.timezone,
    orderNumber: t.order.number,
    topic: t.topic,
    state: t.state,
    escalationReason: t.escalationReason,
    escalatedAt: t.escalatedAt!.toISOString(),
    ageMinutes: Math.max(0, Math.floor((now - t.escalatedAt!.getTime()) / 60_000)),
    waiting: t.state === "escalated" || !t.lastReplyAt || (!!t.lastCustomerAt && t.lastCustomerAt > t.lastReplyAt),
    seenAt: t.lastCustomerAt?.toISOString() ?? null,
    messages: t.messages.map((m) => ({
      id: m.id,
      sender: m.sender as ThreadMessage["sender"],
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      senderName: m.senderUser?.name ?? null,
    })),
  }));
  return { threads, hidden: Math.max(0, total - threads.length) };
}

const replySchema = z.strictObject({
  threadId: z.string().min(1).max(200),
  body: messageBodySchema,
});

const resolveSchema = z.strictObject({ threadId: z.string().min(1).max(200), seenAt: z.iso.datetime().nullable() });

type Result = { ok: true } | { ok: false; error: string };

/** A platform admin's reply on any store's thread. The customer sees it as the platform team; the thread is open again. */
export async function replyAsPlatformAction(input: unknown): Promise<Result> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(replySchema, input);
  if (!parsed.ok) return { ok: false, error: "Write a reply of up to 1000 characters." };
  const { threadId, body } = parsed.data;

  const token = await platformAdminTransaction(async (tx) => {
    const thread = await tx.supportThread.findUnique({
      where: { id: threadId },
      select: { id: true, storeId: true, order: { select: { trackingToken: true } } },
    });
    if (!thread) return undefined;
    const now = new Date();
    await tx.supportMessage.create({
      data: { storeId: thread.storeId, threadId, sender: "platform", senderUserId: session.user.id, body, createdAt: now },
    });
    await tx.supportThread.update({ where: { id: threadId }, data: { lastReplyAt: now, state: "open" } });
    return thread.order.trackingToken;
  });
  if (token === undefined) return { ok: false, error: "Thread not found" };

  if (token) revalidateTag(orderMessagesTag(token), { expire: 0 });
  revalidatePath("/admin/support");
  return { ok: true };
}

/**
 * Closes the thread and leaves an audit row naming the admin. Refused when the customer wrote after
 * `seenAt`, the newest customer message time the admin's page showed. A later customer message reopens it.
 */
export async function resolveThreadAction(input: unknown): Promise<Result> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(resolveSchema, input);
  if (!parsed.ok) return { ok: false, error: "Thread not found" };
  const { threadId, seenAt } = parsed.data;

  const outcome = await platformAdminTransaction(async (tx) => {
    const thread = await tx.supportThread.findUnique({ where: { id: threadId }, select: { storeId: true, state: true } });
    if (!thread) return "missing";
    // Conditional, so a customer message committed after the page loaded, or racing this resolve, wins.
    const { count } = await tx.supportThread.updateMany({
      where: { id: threadId, OR: [{ lastCustomerAt: null }, ...(seenAt ? [{ lastCustomerAt: { lte: new Date(seenAt) } }] : [])] },
      data: { state: "resolved" },
    });
    if (count === 0) return "stale";
    await tx.auditLog.create({
      data: {
        storeId: thread.storeId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "support_thread_resolved",
        entityType: "support_thread",
        entityId: threadId,
        before: { state: thread.state },
        after: { state: "resolved" },
      },
    });
    return "resolved";
  });
  if (outcome === "missing") return { ok: false, error: "Thread not found" };
  if (outcome === "stale") return { ok: false, error: "A new customer message came in. Reload the page to read it." };
  revalidatePath("/admin/support");
  return { ok: true };
}
