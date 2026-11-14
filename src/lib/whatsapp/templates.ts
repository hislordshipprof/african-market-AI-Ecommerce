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

/** Templates the platform sends. The fake rejects any other name, as Meta does (132001). */
export const APPROVED_TEMPLATES: ReadonlyArray<{ name: string; language: string }> = [
  OWNER_LINK_TEMPLATE,
  HELLO_WORLD_TEMPLATE,
];

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
