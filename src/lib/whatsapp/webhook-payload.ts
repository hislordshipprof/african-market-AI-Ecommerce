import { z } from "zod";

/**
 * Cloud API webhook body: object "whatsapp_business_account", entry[].changes[]
 * with value.metadata.phone_number_id and optional messages[] and statuses[].
 * Loose objects: Meta adds fields over time, and unknown keys are ignored.
 *
 * Messages are parsed one by one, so one message Meta shapes differently never
 * drops the others in the same request. Since April 2026 every message carries
 * the sender's business-scoped user id (`from_user_id`), and `from` (the phone
 * number wa_id) is omitted when the user has adopted a username.
 */
const messageSchema = z.looseObject({
  from: z.string().min(1).max(64).optional(),
  from_user_id: z.string().min(1).max(128).optional(),
  id: z.string().min(1).max(256),
  timestamp: z.string().max(20).optional(),
  type: z.string().min(1).max(40),
  text: z.looseObject({ body: z.string().max(65_536) }).optional(),
});

const statusSchema = z.looseObject({
  status: z.string().max(40),
  errors: z.array(z.looseObject({ code: z.number().int().optional() })).max(20).optional(),
});

const valueSchema = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string().max(64) }).optional(),
  messages: z.array(z.unknown()).max(500).optional(),
  statuses: z.array(statusSchema).max(500).optional(),
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
}

export interface ExtractedWebhook {
  messages: InboundMessage[];
  /** Numeric error codes of `failed` delivery statuses, for logs only. */
  failedStatusCodes: number[];
  /** Messages skipped because they had no usable id or shape. */
  unreadableMessages: number;
}

/**
 * Messages and failed statuses addressed to the platform's number, in order.
 * Anything for another phone_number_id, or another object, is ignored.
 */
export function extractWebhook(payload: WhatsAppWebhook, phoneNumberId: string | undefined): ExtractedWebhook {
  const result: ExtractedWebhook = { messages: [], failedStatusCodes: [], unreadableMessages: 0 };
  if (payload.object !== "whatsapp_business_account" || !phoneNumberId) return result;
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const { value } = change;
      if (value.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const candidate of value.messages ?? []) {
        const parsed = messageSchema.safeParse(candidate);
        if (!parsed.success) {
          result.unreadableMessages += 1;
          continue;
        }
        const message = parsed.data;
        result.messages.push({
          id: message.id,
          from: message.from ?? null,
          fromUserId: message.from_user_id ?? null,
          type: message.type,
          text: message.type === "text" && message.text ? message.text.body : null,
        });
      }
      for (const status of value.statuses ?? []) {
        if (status.status !== "failed") continue;
        for (const error of status.errors ?? []) {
          if (typeof error.code === "number") result.failedStatusCodes.push(error.code);
        }
      }
    }
  }
  return result;
}
