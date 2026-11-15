import { recordWhatsAppOptOut } from "../db";
import { messageRef } from "./code";
import type { InboundMessage } from "./webhook-payload";

const WA_ID = /^\d{8,15}$/;

/**
 * A customer's message to a store's own number (#558). This is the seam the
 * Shopper assistant on WhatsApp replaces (ADR-0010, Phase 2). A "STOP" opts
 * that sender out of order updates from this store only (#560). Nothing is
 * sent back: under coexistence the owner answers in the WhatsApp Business
 * app, and an automatic reply would talk over them.
 */
export async function handleCustomerMessage(input: { storeId: string; message: InboundMessage }): Promise<void> {
  const { storeId, message } = input;
  const waId = message.from?.replace(/^\+/, "") ?? "";
  const stop = message.type === "text" && WA_ID.test(waId)
    && (message.text ?? "").trim().toUpperCase() === "STOP";
  if (stop) await recordWhatsAppOptOut(storeId, waId);
  console.info(JSON.stringify({
    event: stop ? "whatsapp_customer_opted_out" : "whatsapp_customer_inbound",
    storeId,
    message: messageRef(message.id),
    type: message.type,
  }));
}
