import { headers } from "next/headers";
import { z } from "zod";
import { clientIp } from "../assistant/client-ip";
import { findStoreForHeaders, type ValidatedStore } from "../get-store";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { acpAuthorized, acpCheckoutEnabled, acpStoreOpen, type AcpResult } from "./checkout-sessions";

const CALLS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;

const items = z.array(z.object({ id: z.string().min(1).max(200), quantity: z.number().int().min(1).max(999).default(1) })).min(1).max(100);
const buyer = z.object({
  first_name: z.string().trim().max(100).optional(),
  last_name: z.string().trim().max(100).optional(),
  email: z.string().trim().email().max(254).optional(),
  phone_number: z.string().trim().max(40).optional(),
});

// Unknown keys are dropped: an agent's unit_amount or totals never reach the quote (#574 AC3).
export const createSessionSchema = z.object({ line_items: items, buyer: buyer.optional() });
export const updateSessionSchema = z.object({ line_items: items.optional(), buyer: buyer.optional() });
export const completeSessionSchema = z.object({
  buyer: buyer.optional(),
  payment_data: z.object({
    instrument: z.object({ credential: z.object({ type: z.literal("spt"), token: z.string().min(1).max(200) }) }),
  }),
});
export const sessionIdSchema = z.string().min(1).max(64);

export const acpError = (status: number, code: string, message: string) =>
  Response.json({ type: "invalid_request", code, message }, { status });

/** The host the agent called. `request.url` carries the server's own listen address under `next start`. */
function hostOrigin(request: Request): string | null {
  const host = request.headers.get("host");
  if (!host) return null;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return `${proto === "https" ? "https" : "http"}://${host}`;
}

/**
 * The gate every ACP checkout route passes first (#574): the flag (fake payments only), an open, opted-in
 * store on this host, the agent platform's bearer key, then 60 calls a minute per IP.
 */
export async function acpGate(request: Request): Promise<{ store: ValidatedStore; origin: string } | Response> {
  if (!acpCheckoutEnabled()) return acpError(404, "not_found", "Not found");
  const store = await findStoreForHeaders(await headers());
  const origin = hostOrigin(request);
  if (!acpStoreOpen(store) || !origin) return acpError(404, "not_found", "Not found");
  if (!acpAuthorized(request.headers.get("authorization"))) return acpError(401, "unauthorized", "A valid bearer key is required.");
  const limit = await takeRateLimit(`acp:ip:${clientIp(request.headers)}`, CALLS_PER_MINUTE, WINDOW_MS);
  if (!limit.ok) {
    return Response.json({ type: "invalid_request", code: "rate_limited", message: "Too many requests" }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  }
  return { store, origin };
}

/** The JSON body, or null when it is missing, too large or not JSON. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function respond(result: AcpResult): Response {
  return Response.json(result.body, { status: result.status });
}
