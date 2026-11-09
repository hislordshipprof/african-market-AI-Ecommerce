import { z } from "zod";

/**
 * Cloud API webhook body: object "whatsapp_business_account", entry[].changes[]
 * with value.metadata.phone_number_id and optional messages[] and statuses[].
 * Loose objects: Meta adds fields over time, and unknown keys are ignored.
 */
const messageSchema = z.looseObject({
  from: z.string().min(1).max(64),
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
  messages: z.array(messageSchema).max(500).optional(),
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
  /** Sender's wa_id. */
  from: string;
  type: string;
  /** Text body for type "text"; null for every other type. */
  text: string | null;
}

export interface ExtractedWebhook {
  messages: InboundMessage[];
  /** Numeric error codes of `failed` delivery statuses, for logs only. */
  failedStatusCodes: number[];
}

/**
 * Messages and failed statuses addressed to the platform's number, in order.
 * Anything for another phone_number_id, or another object, is ignored.
 */
export function extractWebhook(payload: WhatsAppWebhook, phoneNumberId: string | undefined): ExtractedWebhook {
  const result: ExtractedWebhook = { messages: [], failedStatusCodes: [] };
  if (payload.object !== "whatsapp_business_account" || !phoneNumberId) return result;
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const { value } = change;
      if (value.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const message of value.messages ?? []) {
        result.messages.push({
          id: message.id,
          from: message.from,
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
