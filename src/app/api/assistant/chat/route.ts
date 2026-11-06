import { createChatHandler } from "@/lib/assistant/chat-handler";
import { loadCheckoutPrefill } from "@/lib/customer-account/checkout-profile";
import { validPhone } from "@/lib/customer-account/phone";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = createChatHandler({
  loadAccountContact: async (userId) => {
    const prefill = await loadCheckoutPrefill(userId);
    return prefill.contact;
  },
  loadMaskedFacts: async (userId) => {
    const prefill = await loadCheckoutPrefill(userId);
    if (prefill.cardsUnavailable) {
      return { contactOnFile: false, card: null, addressOnFile: prefill.defaultAddress !== null, savedPaymentMethodId: null };
    }
    const card = prefill.cards.find((item) => item.reusable && !item.expired) ?? null;
    return {
      contactOnFile: validPhone(prefill.contact.phone),
      card: card ? { brand: card.brand, last4: card.last4 } : null,
      addressOnFile: prefill.defaultAddress !== null,
      savedPaymentMethodId: card?.id ?? null,
    };
  },
});
