import type { OutboundMessage } from "./types";

/**
 * Authentication-category template with a copy-code button. It must exist,
 * approved, on the WhatsApp Business account. Meta fixes the body wording
 * ("<code> is your verification code."), so the store-admin page tells the
 * owner to reply with the code.
 */
export const OWNER_LINK_TEMPLATE = { name: "owner_link_code", language: "en_US" } as const;

/** Meta's sample template on every new business account; used by the sandbox test. */
export const HELLO_WORLD_TEMPLATE = { name: "hello_world", language: "en_US" } as const;

/**
 * Utility templates for customer order updates (#560), sent from the store's
 * own number, so each is created on the store's WhatsApp Business account.
 * Body: "{{1}}" is the store name. One URL button ("Track order", or "Choose
 * now" for the substitution prompt) whose base is the store's own host and
 * whose one dynamic suffix is the tracking path, as Meta allows a variable
 * only at the end of a button URL. No order id or number.
 */
export const ORDER_UPDATE_TEMPLATES = {
  placed: { name: "order_placed", language: "en_US" },
  accepted: { name: "order_accepted", language: "en_US" },
  ready_pickup: { name: "order_ready_pickup", language: "en_US" },
  ready_delivery: { name: "order_ready_delivery", language: "en_US" },
  out_for_delivery: { name: "order_out_for_delivery", language: "en_US" },
  delivered: { name: "order_delivered", language: "en_US" },
  completed: { name: "order_completed", language: "en_US" },
  cancelled: { name: "order_cancelled", language: "en_US" },
  refunded: { name: "order_refund_issued", language: "en_US" },
  substitution: { name: "order_substitution_prompt", language: "en_US" },
} as const;

const ORDER_UPDATE_NAMES: ReadonlySet<string> = new Set(Object.values(ORDER_UPDATE_TEMPLATES).map((template) => template.name));

export function isOrderUpdateTemplate(name: string): boolean {
  return ORDER_UPDATE_NAMES.has(name);
}

/** Templates the platform sends. The fake rejects any other name, as Meta does (132001). */
export const APPROVED_TEMPLATES: ReadonlyArray<{ name: string; language: string }> = [
  OWNER_LINK_TEMPLATE,
  HELLO_WORLD_TEMPLATE,
  ...Object.values(ORDER_UPDATE_TEMPLATES),
];

/** An order update: the store name in the body, the tracking path as the button's URL suffix. */
export function orderUpdateMessage(
  to: string,
  template: { name: string; language: string },
  storeName: string,
  linkSuffix: string,
): OutboundMessage {
  return {
    type: "template",
    to,
    name: template.name,
    language: template.language,
    components: [
      { type: "body", parameters: [{ type: "text", text: storeName }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: linkSuffix }] },
    ],
  };
}

/**
 * Send payload for the copy-code template: the code as the one body parameter
 * and as the button parameter (index "0"). Meta's create API names the button
 * type OTP; for sends Meta's sample uses sub_type "url" [unverified, #143].
 */
export function ownerLinkCodeMessage(to: string, code: string): OutboundMessage {
  return {
    type: "template",
    to,
    name: OWNER_LINK_TEMPLATE.name,
    language: OWNER_LINK_TEMPLATE.language,
    components: [
      { type: "body", parameters: [{ type: "text", text: code }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
    ],
  };
}
