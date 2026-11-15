import { z } from "zod";

/**
 * Cloud API webhook body: object "whatsapp_business_account", entry[].changes[]
 * with value.metadata.phone_number_id and optional messages[] and statuses[].
 * Loose objects: Meta adds fields over time, and unknown keys are ignored.
 *
 * Messages and statuses are parsed one by one, so one item Meta shapes
 * differently never drops the others in the same request. Fields the code
 * does not depend on (timestamp, text) are read leniently. Since April 2026
 * every message carries the sender's business-scoped user id
 * (`from_user_id`, e.g. "US.13491208655302741918"), and `from` (the phone
 * number wa_id) is omitted when the user has adopted a username.
 */
// Postgres text cannot hold NUL, so such an id would fail the claim on every redelivery.
const NO_NUL = /^[^\u0000]*$/;

const messageSchema = z.looseObject({
  from: z.string().min(1).max(64).regex(NO_NUL).optional(),
  from_user_id: z.string().min(1).max(160).regex(NO_NUL).optional(),
  id: z.string().min(1).max(256).regex(NO_NUL),
  timestamp: z.unknown().optional(),
  type: z.string().min(1).max(40),
  text: z.unknown().optional(),
  group_id: z.unknown().optional(),
  interactive: z.looseObject({
    type: z.string().max(40),
    list_reply: z.looseObject({ id: z.string().min(1).max(256) }).optional(),
    button_reply: z.looseObject({ id: z.string().min(1).max(256) }).optional(),
  }).optional(),
});

const textSchema = z.looseObject({ body: z.string().max(65_536) });

const statusSchema = z.looseObject({
  status: z.string().max(40),
  errors: z.array(z.looseObject({ code: z.number().int().optional() })).max(20).optional(),
});

const valueSchema = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string().max(64) }).optional(),
  messages: z.array(z.unknown()).max(500).optional(),
  statuses: z.array(z.unknown()).max(500).optional(),
});

export const whatsappWebhookSchema = z.looseObject({
  object: z.string().max(64),
  entry: z
    .array(
      z.looseObject({
        changes: z.array(z.looseObject({ field: z.string().max(64).optional(), value: valueSchema })).max(100),
      }),
    )
    .max(100),
});

export type WhatsAppWebhook = z.infer<typeof whatsappWebhookSchema>;

export interface InboundMessage {
  id: string;
  /** Sender's phone-number wa_id; null when Meta omits it (username users). */
  from: string | null;
  /** Sender's business-scoped user id, when present. */
  fromUserId: string | null;
  type: string;
  /** Text body for type "text"; null for every other type. */
  text: string | null;
  /** Meta's send time in Unix seconds; null when missing or not a number. */
  timestamp: number | null;
  /** The id of a tapped list row or reply button (type "interactive"); null otherwise. */
  replyId: string | null;
  /** Sent in a group chat (Meta's `group_id`), not to the business directly. */
  inGroup: boolean;
}

/** An inbound message and the business number it was sent to. */
export interface AddressedMessage {
  phoneNumberId: string;
  message: InboundMessage;
}

export interface ExtractedWebhook {
  messages: AddressedMessage[];
  /** Numeric error codes of `failed` delivery statuses, for logs only. */
  failedStatusCodes: number[];
  /** Top-level key names (never values) of each message skipped for no usable id or shape. */
  unreadable: string[][];
}

function keyNames(candidate: unknown): string[] {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
  return Object.keys(candidate).sort().slice(0, 20).map((key) => key.slice(0, 40));
}

/** Meta documents a string of Unix seconds; a number is read the same way. */
function unixSeconds(value: unknown): number | null {
  const raw = typeof value === "number" ? String(value) : value;
  return typeof raw === "string" && /^\d{1,12}$/.test(raw) ? Number(raw) : null;
}

/**
 * Messages, each with the phone_number_id it was sent to, and failed
 * statuses, in order. A change with no phone_number_id, or another object,
 * is ignored. The caller routes by number (#558).
 */
export function extractWebhook(payload: WhatsAppWebhook): ExtractedWebhook {
  const result: ExtractedWebhook = { messages: [], failedStatusCodes: [], unreadable: [] };
  if (payload.object !== "whatsapp_business_account") return result;
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const { value } = change;
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      for (const candidate of value.messages ?? []) {
        const parsed = messageSchema.safeParse(candidate);
        if (!parsed.success) {
          result.unreadable.push(keyNames(candidate));
          continue;
        }
        const message = parsed.data;
        const text = textSchema.safeParse(message.text);
        result.messages.push({
          phoneNumberId,
          message: {
            id: message.id,
            from: message.from ?? null,
            fromUserId: message.from_user_id ?? null,
            type: message.type,
            text: message.type === "text" && text.success ? text.data.body : null,
            timestamp: unixSeconds(message.timestamp),
            replyId: message.type === "interactive"
              ? message.interactive?.list_reply?.id ?? message.interactive?.button_reply?.id ?? null
              : null,
            inGroup: message.group_id !== undefined && message.group_id !== null,
          },
        });
      }
      for (const candidate of value.statuses ?? []) {
        const parsed = statusSchema.safeParse(candidate);
        if (!parsed.success) continue;
        const status = parsed.data;
        if (status.status !== "failed") continue;
        for (const error of status.errors ?? []) {
          if (typeof error.code === "number") result.failedStatusCodes.push(error.code);
        }
      }
    }
  }
  return result;
}
