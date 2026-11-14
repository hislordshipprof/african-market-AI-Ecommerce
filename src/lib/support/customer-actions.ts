"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidateTag } from "next/cache";
import { getStore } from "../get-store";
import { clientIp } from "../assistant/client-ip";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { parseInput } from "../security/parse-input";
import { announceCustomerMessage, messageBodySchema, orderMessagesTag, postCustomerMessage, SUPPORT_TOPICS, trackingTokenKey } from "./thread";

const HOUR_MS = 60 * 60 * 1000;
const PER_TOKEN_PER_HOUR = 30;
const PER_IP_PER_HOUR = 60;

const sendSchema = z.strictObject({
  token: z.string().min(1).max(200),
  body: messageBodySchema,
  topic: z.enum(SUPPORT_TOPICS).optional(),
});

type SendResult = { ok: true } | { ok: false; error: string };

/**
 * Public: the tracking token is the only credential. The store comes from the host, the order from the token.
 * `topic` applies only when the message opens the thread.
 */
export async function sendOrderMessageAction(input: unknown): Promise<SendResult> {
  const parsed = parseInput(sendSchema, input);
  if (!parsed.ok) return { ok: false, error: "Write a message of up to 1000 characters." };
  const { token, body, topic } = parsed.data;

  const [store, reqHeaders] = await Promise.all([getStore(), headers()]);
  const byIp = await takeRateLimit(`support-message:ip:${clientIp(reqHeaders)}`, PER_IP_PER_HOUR, HOUR_MS);
  const byToken = byIp.ok ? await takeRateLimit(`support-message:token:${trackingTokenKey(token)}`, PER_TOKEN_PER_HOUR, HOUR_MS) : byIp;
  if (!byToken.ok) return { ok: false, error: "Too many messages. Please wait and try again." };

  const posted = await postCustomerMessage(store.id, token, body, topic);
  if (!posted) return { ok: false, error: "We couldn't find this order." };

  revalidateTag(orderMessagesTag(token), { expire: 0 });
  announceCustomerMessage(store, posted, body);
  return { ok: true };
}
