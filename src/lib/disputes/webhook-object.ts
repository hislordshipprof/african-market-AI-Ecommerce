import type { WebhookDispute } from "../stripe/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
function idOf(value: any): string | null {
  if (typeof value === "string") return value;
  return typeof value?.id === "string" ? value.id : null;
}

/** The dispute in a Stripe event object, shared by the real and the fake provider. */
export function disputeObject(obj: any): { dispute?: WebhookDispute } {
  if (obj?.object !== "dispute" || typeof obj.id !== "string") return {};
  const chargeId = idOf(obj.charge);
  if (!chargeId || !Number.isInteger(obj.amount) || typeof obj.status !== "string") return {};
  const transactions: any[] = Array.isArray(obj.balance_transactions) ? obj.balance_transactions : [];
  return {
    dispute: {
      id: obj.id,
      chargeId,
      paymentIntentId: idOf(obj.payment_intent),
      amountCents: obj.amount,
      currency: typeof obj.currency === "string" ? obj.currency : "usd",
      reason: typeof obj.reason === "string" ? obj.reason : "general",
      status: obj.status,
      evidenceDueBy: Number.isInteger(obj.evidence_details?.due_by) ? obj.evidence_details.due_by : null,
      livemode: obj.livemode === true,
      feeCents: transactions.reduce((sum, t) => sum + (Number.isInteger(t?.fee) ? t.fee : 0), 0),
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
