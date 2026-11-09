import { readSendConfig } from "./config";
import { WhatsAppApiError, WhatsAppNotConfiguredError } from "./errors";
import type { OutboundMessage, SendResult, WhatsAppProvider } from "./types";

/**
 * Graph API version, pinned in one place. v25.0 is the newest release found
 * (Feb 2026); Meta's changelog could not be opened to confirm a later one [unverified, #143].
 */
export const GRAPH_API_VERSION = "v25.0";
const SEND_TIMEOUT_MS = 10_000;

/** Meta's `to` accepts digits; the plus is dropped so `to` and wa_id compare equal. */
function recipient(to: string): string {
  return to.replace(/^\+/, "");
}

export function toGraphPayload(message: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: recipient(message.to) };
  switch (message.type) {
    case "text":
      return { ...base, type: "text", text: { body: message.body, preview_url: false } };
    case "interactive":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: message.body },
          action: {
            buttons: message.buttons.map((button) => ({
              type: "reply",
              reply: { id: button.id, title: button.title },
            })),
          },
        },
      };
    case "template":
      return {
        ...base,
        type: "template",
        template: {
          name: message.name,
          language: { code: message.language },
          ...(message.components ? { components: message.components } : {}),
        },
      };
    case "media":
      return {
        ...base,
        type: message.mediaType,
        [message.mediaType]: {
          link: message.link,
          ...(message.caption && message.mediaType !== "audio" ? { caption: message.caption } : {}),
        },
      };
  }
}

function graphErrorCode(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code) ? code : null;
}

function readSendResult(body: unknown): SendResult | null {
  if (!body || typeof body !== "object") return null;
  const messages = (body as { messages?: unknown }).messages;
  const contacts = (body as { contacts?: unknown }).contacts;
  const first = Array.isArray(messages) ? (messages[0] as { id?: unknown } | undefined) : undefined;
  if (!first || typeof first.id !== "string" || first.id.length === 0) return null;
  const contact = Array.isArray(contacts) ? (contacts[0] as { wa_id?: unknown } | undefined) : undefined;
  const waId = contact && typeof contact.wa_id === "string" && contact.wa_id.length > 0 ? contact.wa_id : null;
  return { messageId: first.id, waId };
}

/**
 * Cloud API adapter. Keys are read on each send. No automatic retry: the send
 * endpoint has no idempotency key, so a retry could deliver twice.
 */
export const cloudApiWhatsAppProvider: WhatsAppProvider = {
  async send(message) {
    const config = readSendConfig();
    if (!config) throw new WhatsAppNotConfiguredError();
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(config.phoneNumberId)}/messages`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toGraphPayload(message)),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      throw new WhatsAppApiError(null, 0);
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) throw new WhatsAppApiError(graphErrorCode(body), response.status);
    const result = readSendResult(body);
    if (!result) throw new WhatsAppApiError(null, response.status);
    return result;
  },
};
