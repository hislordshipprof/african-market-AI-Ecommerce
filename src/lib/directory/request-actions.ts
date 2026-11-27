"use server";

import { headers } from "next/headers";
import { clientIp } from "../assistant/client-ip";
import { readBrowserId } from "../cart/browser";
import { parseInput } from "../security/parse-input";
import { TURNSTILE_FAILED, turnstileRequest, verifyTurnstile } from "../security/turnstile";
import { STORE_REQUEST_BAD, storeRequestInput, submitStoreRequest, type RequestResult } from "./store-requests";

/** Public: "tell me when a store opens near me" from the Store directory (#455). */
export async function requestStoreNotice(input: unknown, turnstileToken?: unknown): Promise<RequestResult> {
  const parsed = parseInput(storeRequestInput, input);
  if (!parsed.ok) return { ok: false, message: STORE_REQUEST_BAD };
  const h = await headers();
  // Fails closed, like the store application (#872).
  if (!(await verifyTurnstile(turnstileToken, turnstileRequest(h))).ok) return { ok: false, message: TURNSTILE_FAILED };
  return submitStoreRequest(parsed.data, { ip: clientIp(h), browser: readBrowserId(h.get("x-shop-browser"), h.get("cookie")) });
}
