import { messageRef } from "./code";
import type { InboundMessage } from "./webhook-payload";

/**
 * A customer's message to a store's own number (#558). This is the seam the
 * Shopper assistant on WhatsApp replaces (ADR-0010, Phase 2). Until then it
 * sends nothing: under coexistence the owner answers in the WhatsApp Business
 * app, and an automatic reply would talk over them.
 */
export async function handleCustomerMessage(input: { storeId: string; message: InboundMessage }): Promise<void> {
  console.info(JSON.stringify({
    event: "whatsapp_customer_inbound",
    storeId: input.storeId,
    message: messageRef(input.message.id),
    type: input.message.type,
  }));
}
