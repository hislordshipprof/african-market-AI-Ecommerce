import { storeScoped } from "@/lib/db";
import { getStripeProvider, type Payout } from "@/lib/stripe";
import { payoutBreakdown, type PayoutBreakdown } from "./breakdown";

export const PAYOUTS_SHOWN = 12;
export const PAYOUTS_ERROR = "We could not load your payouts from Stripe. Please try again in a few minutes.";
export const DASHBOARD_ERROR = "We could not open your Stripe dashboard. Please try again in a few minutes.";

/** The account always comes from the signed-in owner's store, never from the request. */
type PayoutStore = { id: string; stripeAccountId: string | null };

type Result<T> = ({ ok: true } & T) | { ok: false; notFound: boolean; error: string };

/** Raw provider text goes to the server log only; the owner sees the plain message. */
export function logProviderError(op: string, storeId: string, err: unknown): void {
  console.error(JSON.stringify({ event: "stripe_payouts_failed", op, storeId, message: err instanceof Error ? err.message : String(err) }));
}

function failure(op: string, storeId: string, err: unknown): { ok: false; notFound: boolean; error: string } {
  if ((err as { statusCode?: number })?.statusCode === 404) return { ok: false, notFound: true, error: PAYOUTS_ERROR };
  logProviderError(op, storeId, err);
  return { ok: false, notFound: false, error: PAYOUTS_ERROR };
}

export async function storePayouts(store: PayoutStore): Promise<Result<{ payouts: Payout[] }>> {
  if (!store.stripeAccountId) return { ok: true, payouts: [] };
  try {
    return { ok: true, payouts: await getStripeProvider().listPayouts(store.stripeAccountId, PAYOUTS_SHOWN) };
  } catch (err) {
    return failure("list_payouts", store.id, err);
  }
}

export async function storePayoutDetail(
  store: PayoutStore,
  payoutId: string,
): Promise<Result<{ payout: Payout; breakdown: PayoutBreakdown }>> {
  if (!store.stripeAccountId) return { ok: false, notFound: true, error: PAYOUTS_ERROR };
  const stripe = getStripeProvider();
  let payout: Payout;
  let transactions;
  try {
    [payout, transactions] = await Promise.all([
      stripe.retrievePayout(store.stripeAccountId, payoutId),
      stripe.listPayoutTransactions(store.stripeAccountId, payoutId),
    ]);
  } catch (err) {
    return failure("payout_detail", store.id, err);
  }
  const intents = [...new Set(transactions.map((t) => t.paymentIntentId).filter((id): id is string => !!id))];
  const orders = await storeScoped(store.id).order.findMany({
    where: { storeId: store.id, paymentIntentId: { in: intents } },
    select: {
      id: true, number: true, paymentIntentId: true, fulfillment: true, capturedAmountCents: true,
      platformFeeCents: true, serviceFeeCents: true, tipCents: true, deliveryFeeCents: true,
    },
  });
  return { ok: true, payout, breakdown: payoutBreakdown(payout.amountCents, transactions, orders) };
}
