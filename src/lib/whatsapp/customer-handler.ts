import { recordWhatsAppOptOut } from "../db";
import { messageRef } from "./code";
import { handleShopperMessage, type ShopperOptions } from "./shopper";
import type { InboundMessage } from "./webhook-payload";

const WA_ID = /^\d{8,15}$/;

/**
 * A customer's message to a store's own number (#558). A "STOP" opts that
 * sender out of order updates from this store only (#560) and gets no reply.
 * Anything else goes to the shopper assistant on WhatsApp (#559).
 */
export async function handleCustomerMessage(
  input: { storeId: string; message: InboundMessage },
  options: ShopperOptions = {},
): Promise<void> {
  const { storeId, message } = input;
  const waId = message.from?.replace(/^\+/, "") ?? "";
  const stop = message.type === "text" && WA_ID.test(waId)
    && (message.text ?? "").trim().toUpperCase() === "STOP";
  console.info(JSON.stringify({
    event: stop ? "whatsapp_customer_opted_out" : "whatsapp_customer_inbound",
    storeId,
    message: messageRef(message.id),
    type: message.type,
  }));
  if (stop) {
    await recordWhatsAppOptOut(storeId, waId);
    return;
  }
  await handleShopperMessage({ storeId, message }, options);
}
