export type PaymentLoad = "loading" | "ready" | "failed";

/** Whether checkout can take payment (#783): Stripe.js, and the card form when the shopper pays with a new card. */
export function paymentReadiness({ stripe, cardForm, element }: { stripe: PaymentLoad; cardForm: boolean; element: PaymentLoad }): PaymentLoad {
  if (stripe !== "ready") return stripe;
  return cardForm ? element : "ready";
}
