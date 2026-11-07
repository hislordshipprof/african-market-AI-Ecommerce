import { z } from "zod";
import { mintCheckoutToken } from "@/lib/assistant/checkout/confirm";
import { assistantPaymentsHarness } from "@/lib/assistant/checkout/gates";
import { checkoutActor, checkoutJson, readCheckoutBody } from "@/lib/assistant/checkout/http";
import { readStoreCheckoutShift, storeScopedTransaction } from "@/lib/db";
import { parseInput } from "@/lib/security/parse-input";
import { requireSameOrigin } from "@/lib/security/same-origin";

export const runtime = "nodejs";

const cardBody = z.object({ attemptId: z.string().min(1).max(128) }).strict();

export async function POST(request: Request): Promise<Response> {
  if (!requireSameOrigin(request)) {
    return checkoutJson({ ok: false, code: "forbidden_origin", message: "This request was not sent from the store." }, 403);
  }
  const body = await readCheckoutBody(request);
  if (!body.ok) return checkoutJson({ ok: false, code: body.code, message: body.message }, body.status);
  const parsed = parseInput(cardBody, body.body);
  if (!parsed.ok) return checkoutJson({ ok: false, code: "invalid_request", message: "That checkout is not available." }, 400);
  const actor = await checkoutActor(request);
  if (!actor.ok) return checkoutJson({ ok: false, code: actor.code, message: actor.message }, actor.status);
  const minted = await mintCheckoutToken({
    storeId: actor.actor.storeId,
    cartId: actor.actor.cartId,
    actorUserId: actor.actor.actorUserId,
    conversationId: actor.actor.conversationId,
    attemptId: parsed.data.attemptId,
  });
  if (!minted) return checkoutJson({ ok: false, code: "not_found", message: "That checkout is not available." }, 404);
  const account = await storeScopedTransaction(actor.actor.storeId, (tx) => readStoreCheckoutShift(tx, actor.actor.storeId));
  return checkoutJson({
    ok: true,
    token: minted.token,
    card: minted.card,
    harness: assistantPaymentsHarness(),
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
    onBehalfOf: account?.stripeAccountId ?? null,
    amount: minted.card.holdCents ?? null,
    savedPaymentMethodId: minted.savedPaymentMethodId,
  }, 200, actor.actor.headers);
}
