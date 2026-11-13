"use server";

import { z } from "zod";
import { revalidateTag } from "next/cache";
import { READ_ONLY_MESSAGE, requireStoreWriter } from "../store-admin/session";
import { scheduleOrderNotification } from "../inngest/notify";
import { parseInput } from "../security/parse-input";
import { messageBodySchema, orderMessagesTag, replyAsStore } from "./thread";

const replySchema = z.strictObject({
  threadId: z.string().min(1).max(200),
  body: messageBodySchema,
});

/** Any member with write access replies. The store comes from the session; another store's thread is not found. */
export async function replyToThreadAction(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireStoreWriter();
  if (!session) return { ok: false, error: READ_ONLY_MESSAGE };
  const parsed = parseInput(replySchema, input);
  if (!parsed.ok) return { ok: false, error: "Write a reply of up to 1000 characters." };

  const reply = await replyAsStore(session.store.id, session.user.id, parsed.data.threadId, parsed.data.body);
  if (!reply) return { ok: false, error: "Thread not found" };

  if (reply.trackingToken) revalidateTag(orderMessagesTag(reply.trackingToken), { expire: 0 });
  if (reply.notify) scheduleOrderNotification(session.store.id, reply.orderId, "store_replied");
  return { ok: true };
}
