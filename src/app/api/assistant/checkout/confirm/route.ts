import { z } from "zod";
import { confirmCheckout } from "@/lib/assistant/checkout/confirm";
import { checkoutActor, checkoutJson, limitNewPayment, parseCheckout, readCheckoutBody } from "@/lib/assistant/checkout/http";
import { loadCheckoutPrefill } from "@/lib/customer-account/checkout-profile";
import { validPhone } from "@/lib/customer-account/phone";

export const runtime = "nodejs";

const confirmSchema = z.object({
  token: z.string().trim().min(16).max(128),
  phase: z.enum(["reserve", "complete"]),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const body = await readCheckoutBody(request);
  if (!body.ok) return checkoutJson({ ok: false, code: body.code, message: body.message }, body.status);
  const parsed = parseCheckout(confirmSchema, body.body);
  if (!parsed.ok) return checkoutJson({ ok: false, code: parsed.code, message: parsed.message }, parsed.status);
  const actor = await checkoutActor(request);
  if (!actor.ok) return checkoutJson({ ok: false, code: actor.code, message: actor.message }, actor.status);
  if (parsed.data.phase === "reserve") {
    const limit = await limitNewPayment(actor.actor.cartId);
    if (!limit.ok) {
      return checkoutJson({ ok: false, code: "rate_limited", message: "Too many payment attempts. Please wait and try again." }, 429);
    }
  }
  const result = await confirmCheckout({
    storeId: actor.actor.storeId,
    cartId: actor.actor.cartId,
    actorUserId: actor.actor.actorUserId,
    token: parsed.data.token,
    phase: parsed.data.phase,
    loadAccountContact: async (userId) => (await loadCheckoutPrefill(userId)).contact,
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
  const status = result.ok ? 200 : result.code === "not_found" ? 404 : 409;
  return checkoutJson(result, status, actor.actor.headers);
}
