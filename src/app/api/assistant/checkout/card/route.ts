import { mintCheckoutToken } from "@/lib/assistant/checkout/confirm";
import { assistantPaymentsHarness } from "@/lib/assistant/checkout/gates";
import { checkoutActor, checkoutJson } from "@/lib/assistant/checkout/http";
import { storeScopedTransaction } from "@/lib/db";
import { requireSameOrigin } from "@/lib/security/same-origin";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  if (!requireSameOrigin(request)) {
    return checkoutJson({ ok: false, code: "forbidden_origin", message: "This request was not sent from the store." }, 403);
  }
  const actor = await checkoutActor(request);
  if (!actor.ok) return checkoutJson({ ok: false, code: actor.code, message: actor.message }, actor.status);
  if (!actor.actor.conversationId) {
    return checkoutJson({ ok: false, code: "not_found", message: "That checkout is not available." }, 404);
  }
  const minted = await mintCheckoutToken({
    storeId: actor.actor.storeId,
    cartId: actor.actor.cartId,
    actorUserId: actor.actor.actorUserId,
    conversationId: actor.actor.conversationId,
  });
  if (!minted) return checkoutJson({ ok: false, code: "not_found", message: "That checkout is not available." }, 404);
  const account = await storeScopedTransaction(actor.actor.storeId, (tx) => tx.$queryRaw<Array<{ stripe_account_id: string | null }>>`
    SELECT stripe_account_id FROM stores WHERE id = ${actor.actor.storeId}
  `);
  return checkoutJson({
    ok: true,
    token: minted.token,
    card: minted.card,
    harness: assistantPaymentsHarness(),
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
    onBehalfOf: account[0]?.stripe_account_id ?? null,
    amount: minted.card.holdCents ?? null,
  }, 200, actor.actor.headers);
}
