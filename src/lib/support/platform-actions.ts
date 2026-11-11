"use server";

import { z } from "zod";
import { revalidatePath, revalidateTag } from "next/cache";
import { platformAdminTransaction } from "../db";
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
  messages: (ThreadMessage & { senderName: string | null })[];
};

/**
 * Every store's escalated threads not yet resolved, waiting ones first, oldest escalation first.
 * A replied thread is `open` again and stays listed until a platform admin resolves it.
 */
export async function listEscalatedThreads(): Promise<EscalatedThread[]> {
  await requirePlatformAdmin();
  const threads = await platformAdminTransaction((tx) =>
    tx.supportThread.findMany({
      where: { escalatedAt: { not: null }, state: { not: "resolved" } },
      orderBy: { escalatedAt: "asc" },
      take: QUEUE_LIMIT,
      select: {
        id: true,
        topic: true,
        state: true,
        escalationReason: true,
        escalatedAt: true,
        store: { select: { name: true, timezone: true } },
        order: { select: { number: true } },
        messages: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, sender: true, body: true, createdAt: true, senderUser: { select: { name: true } } },
        },
      },
    }),
  );
  return threads
    .map((t) => ({
      id: t.id,
      storeName: t.store.name,
      storeTimezone: t.store.timezone,
      orderNumber: t.order.number,
      topic: t.topic,
      state: t.state,
      escalationReason: t.escalationReason,
      escalatedAt: t.escalatedAt!.toISOString(),
      messages: t.messages.map((m) => ({
        id: m.id,
        sender: m.sender as ThreadMessage["sender"],
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        senderName: m.senderUser?.name ?? null,
      })),
    }))
    .sort((a, b) => Number(b.state === "escalated") - Number(a.state === "escalated"));
}

const replySchema = z.strictObject({
  threadId: z.string().min(1).max(200),
  body: messageBodySchema,
});

const resolveSchema = z.strictObject({ threadId: z.string().min(1).max(200) });

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

/** Closes the thread and leaves an audit row naming the admin. A later customer message reopens it. */
export async function resolveThreadAction(input: unknown): Promise<Result> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(resolveSchema, input);
  if (!parsed.ok) return { ok: false, error: "Thread not found" };
  const { threadId } = parsed.data;

  const resolved = await platformAdminTransaction(async (tx) => {
    const thread = await tx.supportThread.findUnique({ where: { id: threadId }, select: { storeId: true, state: true } });
    if (!thread) return false;
    await tx.supportThread.update({ where: { id: threadId }, data: { state: "resolved" } });
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
    return true;
  });
  if (!resolved) return { ok: false, error: "Thread not found" };
  revalidatePath("/admin/support");
  return { ok: true };
}
