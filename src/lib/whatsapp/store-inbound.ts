import {
  claimInboundWhatsAppMessage,
  findStoreByWhatsAppPhoneNumberId,
  platformAdminTransaction,
  releaseInboundWhatsAppMessage,
} from "../db";
import { messageRef } from "./code";
import { handleCustomerMessage } from "./customer-handler";
import type { ShopperOptions } from "./shopper";
import type { InboundMessage } from "./webhook-payload";

export type StoreInboundOutcome =
  | { kind: "customer"; storeId: string }
  | { kind: "duplicate" }
  | { kind: "unknown_number" };

/**
 * A message to any number other than the platform's (#558). The store is the
 * one whose registered number has exactly this phone_number_id; a number
 * no store has registered is dropped unclaimed with a hashed log line. The
 * lookup and the claim commit together. A handler failure releases the claim
 * and rethrows (the route answers 500), so Meta's redelivery is handled: a
 * shopper turn that finds the previous turn still running does this (#559).
 * A process that dies mid-handler still loses that message.
 */
export async function handleStoreInboundMessage(
  phoneNumberId: string,
  message: InboundMessage,
  options: ShopperOptions = {},
): Promise<StoreInboundOutcome> {
  const outcome = await platformAdminTransaction(async (tx): Promise<StoreInboundOutcome> => {
    const store = await findStoreByWhatsAppPhoneNumberId(tx, phoneNumberId);
    if (!store) return { kind: "unknown_number" };
    if (!(await claimInboundWhatsAppMessage(tx, message.id))) return { kind: "duplicate" };
    return { kind: "customer", storeId: store.storeId };
  });

  if (outcome.kind === "unknown_number") {
    console.info(JSON.stringify({
      event: "whatsapp_inbound_unknown_number",
      number: messageRef(phoneNumberId),
      message: messageRef(message.id),
    }));
    return outcome;
  }
  if (outcome.kind === "customer") {
    try {
      await handleCustomerMessage({ storeId: outcome.storeId, message }, options);
    } catch (error) {
      await releaseInboundWhatsAppMessage(message.id);
      throw error;
    }
  }
  return outcome;
}
