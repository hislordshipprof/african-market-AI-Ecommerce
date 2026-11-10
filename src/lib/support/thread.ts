import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma, storeScoped, storeScopedRawQuery, storeScopedTransaction } from "../db";
import { recordOrderNotification } from "../notifications/record";

const MESSAGE_MAX_CHARS = 1000;
// Postgres text rejects NUL, so refuse it here instead of failing in the insert.
export const messageBodySchema = z.string().trim().min(1).max(MESSAGE_MAX_CHARS).refine((body) => !body.includes("\u0000"));
const THREAD_LIST_LIMIT = 100;

export type ThreadMessage = {
  id: string;
  sender: "customer" | "store" | "platform";
  body: string;
  createdAt: string;
};

export type StoreThreadSummary = {
  id: string;
  orderNumber: number;
  state: string;
  lastCustomerAt: Date | null;
  lastReplyAt: Date | null;
  unread: number;
};

/** The customer poll's cache tag. Hashed so the tracking token is never a cache key in the clear. */
export function orderMessagesTag(token: string): string {
  return `order-messages:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

function toMessage(row: { id: string; sender: string; body: string; createdAt: Date }): ThreadMessage {
  return { id: row.id, sender: row.sender as ThreadMessage["sender"], body: row.body, createdAt: row.createdAt.toISOString() };
}

/**
 * The order comes from the tracking token in this store only; there is no order-id fallback.
 * Opens the order's thread on the first message. Null when the token is unknown here.
 */
export async function postCustomerMessage(
  storeId: string,
  token: string,
  body: string,
): Promise<{ threadId: string; orderNumber: number } | null> {
  return storeScopedTransaction(storeId, async (tx) => {
    const order = await tx.order.findUnique({ where: { trackingToken: token }, select: { id: true, number: true } });
    if (!order) return null;
    await tx.supportThread.createMany({ data: [{ storeId, orderId: order.id }], skipDuplicates: true });
    const now = new Date();
    const thread = await tx.supportThread.update({
      where: { orderId: order.id },
      data: { lastCustomerAt: now },
      select: { id: true },
    });
    await tx.supportMessage.create({
      data: { storeId, threadId: thread.id, sender: "customer", body, createdAt: now },
    });
    return { threadId: thread.id, orderNumber: order.number };
  });
}

/** What the tracking page shows. Null when the token is unknown in this store. */
export async function readCustomerMessages(storeId: string, token: string): Promise<ThreadMessage[] | null> {
  const order = await storeScoped(storeId).order.findUnique({
    where: { trackingToken: token },
    select: {
      supportThreads: {
        select: {
          messages: {
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, sender: true, body: true, createdAt: true },
          },
        },
      },
    },
  });
  if (!order) return null;
  return (order.supportThreads[0]?.messages ?? []).map(toMessage);
}

/** Unread is the customer messages since the store's last reply. Newest customer message first. */
export async function listStoreThreads(storeId: string): Promise<StoreThreadSummary[]> {
  return storeScopedRawQuery<StoreThreadSummary>(storeId, Prisma.sql`
    SELECT t.id, o.number AS "orderNumber", t.state,
           t.last_customer_at AS "lastCustomerAt", t.last_reply_at AS "lastReplyAt",
           (SELECT count(*)::int FROM support_messages m
             WHERE m.thread_id = t.id AND m.sender = 'customer'
               AND m.created_at > COALESCE(t.last_reply_at, '-infinity'::timestamp)) AS unread
      FROM support_threads t
      JOIN orders o ON o.id = t.order_id
     ORDER BY COALESCE(t.last_customer_at, t.created_at) DESC
     LIMIT ${THREAD_LIST_LIMIT}`);
}

export async function storeUnreadCount(storeId: string): Promise<number> {
  const rows = await storeScopedRawQuery<{ unread: number }>(storeId, Prisma.sql`
    SELECT count(*)::int AS unread
      FROM support_messages m
      JOIN support_threads t ON t.id = m.thread_id
     WHERE m.sender = 'customer' AND m.created_at > COALESCE(t.last_reply_at, '-infinity'::timestamp)`);
  return rows[0]?.unread ?? 0;
}

export async function getStoreThread(storeId: string, threadId: string) {
  const thread = await storeScoped(storeId).supportThread.findUnique({
    where: { id: threadId },
    select: {
      id: true,
      state: true,
      order: { select: { number: true, status: true, customer: { select: { name: true } } } },
      messages: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, sender: true, body: true, createdAt: true, senderUser: { select: { name: true } } },
      },
    },
  });
  if (!thread) return null;
  return {
    id: thread.id,
    state: thread.state,
    orderNumber: thread.order.number,
    orderStatus: thread.order.status,
    customerName: thread.order.customer.name,
    messages: thread.messages.map((m) => ({ ...toMessage(m), senderName: m.senderUser?.name ?? null })),
  };
}

/**
 * A store member's reply. The first reply on a thread records one "store_replied" row per channel;
 * later replies record none (`notify` is false). Null when the thread is not this store's.
 */
export async function replyAsStore(
  storeId: string,
  userId: string,
  threadId: string,
  body: string,
): Promise<{ orderId: string; trackingToken: string | null; notify: boolean } | null> {
  return storeScopedTransaction(storeId, async (tx) => {
    const thread = await tx.supportThread.findUnique({
      where: { id: threadId },
      select: { id: true, orderId: true, order: { select: { trackingToken: true } } },
    });
    if (!thread) return null;
    const now = new Date();
    await tx.supportMessage.create({
      data: { storeId, threadId, sender: "store", senderUserId: userId, body, createdAt: now },
    });
    await tx.supportThread.update({ where: { id: threadId }, data: { lastReplyAt: now } });
    const notify = await recordOrderNotification(tx, storeId, thread.orderId, "store_replied");
    return { orderId: thread.orderId, trackingToken: thread.order.trackingToken, notify };
  });
}
