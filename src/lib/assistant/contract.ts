/**
 * Pure route contract. Safe for the browser to import. Do not import the
 * chat handler, Prisma, or the model from here.
 */

export const ASSISTANT_DISABLED_CODE = "assistant_disabled";
export const ASSISTANT_DISABLED_STATUS = 404;
export const ASSISTANT_DISABLED_MESSAGE = "The helper is not available.";

export const ASSISTANT_FIXED_ERROR = "Sorry, something went wrong. Please try again.";

/** Tools the assistant registers. The browser and the server share this list. */
export const ASSISTANT_TOOL_NAMES = [
  "search_catalog",
  "show_products",
  "check_availability",
  "suggest_substitutes",
  "add_to_cart",
  "update_cart",
  "remove_from_cart",
  "set_swap_rule",
  "get_cart_summary",
  "offer_choices",
  "get_order_status",
  "check_delivery_area",
  "get_store_info",
  "forward_to_store",
] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOL_NAMES)[number];

/**
 * The argument's keys must be exactly `AssistantToolName`.
 * An extra key or a missing key fails typecheck.
 */
export function exactAssistantKeys<const T extends Record<AssistantToolName, unknown>>(
  value: [Exclude<keyof T, AssistantToolName>] extends [never] ? T : never,
): T {
  return value;
}

/** Codes the chat handler can return. The client maps every one of these. */
export const ASSISTANT_ROUTE_CODES = [
  "invalid_request",
  "forbidden_origin",
  "store_suspended",
  "store_not_found",
  "assistant_busy",
  "rate_limited",
  "assistant_resting",
  "assistant_unavailable",
  "assistant_disabled",
  "attachment_too_many",
  "attachment_too_large",
  "attachment_type",
  "attachment_pixels",
  "attachment_pages",
  "attachment_encrypted",
  "attachment_missing",
  "attachment_rate_limited",
  "attachment_conflict",
] as const;

export type AssistantRouteCode = (typeof ASSISTANT_ROUTE_CODES)[number];

export const ASSISTANT_ROUTE_STATUS: Record<AssistantRouteCode, number> = {
  invalid_request: 400,
  forbidden_origin: 403,
  store_suspended: 403,
  store_not_found: 404,
  assistant_busy: 409,
  rate_limited: 429,
  assistant_resting: 503,
  assistant_unavailable: 503,
  assistant_disabled: ASSISTANT_DISABLED_STATUS,
  attachment_too_many: 400,
  attachment_too_large: 400,
  attachment_type: 400,
  attachment_pixels: 400,
  attachment_pages: 400,
  attachment_encrypted: 400,
  attachment_missing: 400,
  attachment_rate_limited: 429,
  attachment_conflict: 400,
};

export function assistantChatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ASSISTANT_CHAT_ENABLED === "1";
}

/** Same gate shape as the Stripe CI fake: exact flag, never on Vercel. */
export function assistantFakeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.E2E_FAKE_ASSISTANT !== "1" || env.VERCEL) return false;
  if (env.CI === "true") return true;
  return env.NODE_ENV !== "production";
}

/** Public literal. The fake rejects every other key, including a real one. */
export const E2E_FAKE_ANTHROPIC_KEY = "e2e-fake-anthropic-key";
