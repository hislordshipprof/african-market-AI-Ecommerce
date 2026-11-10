"use server";

import { createHash } from "node:crypto";
import { z } from "zod";
import { headers } from "next/headers";
import { revalidateTag } from "next/cache";
import { getStore } from "../get-store";
import { clientIp } from "../assistant/client-ip";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { scheduleAfterResponse } from "../schedule-after-response";
import { parseInput } from "../security/parse-input";
import { pushToStoreMembers } from "../push/store-members";
import { messageBodySchema, orderMessagesTag, postCustomerMessage } from "./thread";

const HOUR_MS = 60 * 60 * 1000;
const PER_TOKEN_PER_HOUR = 30;
const PER_IP_PER_HOUR = 60;

const sendSchema = z.strictObject({
  token: z.string().min(1).max(200),
  body: messageBodySchema,
});

type SendResult = { ok: true } | { ok: false; error: string };

/** Public: the tracking token is the only credential. The store comes from the host, the order from the token. */
export async function sendOrderMessageAction(input: unknown): Promise<SendResult> {
  const parsed = parseInput(sendSchema, input);
  if (!parsed.ok) return { ok: false, error: "Write a message of up to 1000 characters." };
  const { token, body } = parsed.data;

  const [store, reqHeaders] = await Promise.all([getStore(), headers()]);
  const tokenKey = createHash("sha256").update(token).digest("hex").slice(0, 32);
  const byIp = await takeRateLimit(`support-message:ip:${clientIp(reqHeaders)}`, PER_IP_PER_HOUR, HOUR_MS);
  const byToken = byIp.ok ? await takeRateLimit(`support-message:token:${tokenKey}`, PER_TOKEN_PER_HOUR, HOUR_MS) : byIp;
  if (!byToken.ok) return { ok: false, error: "Too many messages. Please wait and try again." };

  const posted = await postCustomerMessage(store.id, token, body);
  if (!posted) return { ok: false, error: "We couldn't find this order." };

  revalidateTag(orderMessagesTag(token), { expire: 0 });
  scheduleAfterResponse(
    () => pushToStoreMembers(store.id, {
      title: "New message",
      body: `Order #${posted.orderNumber}: ${body.slice(0, 120)}`,
      url: `/store-admin/messages?store=${encodeURIComponent(store.slug)}&thread=${posted.threadId}`,
      tag: `support-${posted.threadId}`,
    }),
    "support_push_failed",
  );
  return { ok: true };
}
