import { claimInboundWhatsAppMessage, findStoreByWhatsAppPhoneNumberId, platformAdminTransaction } from "../db";
import { messageRef } from "./code";
import { handleCustomerMessage } from "./customer-handler";
import type { InboundMessage } from "./webhook-payload";

export type StoreInboundOutcome =
  | { kind: "customer"; storeId: string }
  | { kind: "duplicate" }
  | { kind: "unknown_number" };

/**
 * A message to any number other than the platform's (#558). The store is the
 * one whose registered number has exactly this phone_number_id; a number
 * no store has registered is dropped unclaimed with a hashed log line. The
 * lookup and the claim commit together; a failure rolls the claim back so
 * Meta's redelivery is handled.
 */
export async function handleStoreInboundMessage(
  phoneNumberId: string,
  message: InboundMessage,
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
  if (outcome.kind === "customer") await handleCustomerMessage({ storeId: outcome.storeId, message });
  return outcome;
}
