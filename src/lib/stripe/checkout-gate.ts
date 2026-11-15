import { checkoutPaymentsUseFake } from "./checkout-payments";
import type { OnboardingStatus } from "./types";

export interface CheckoutGateResult {
  enabled: boolean;
  message: string | null;
}

export const STORE_OPENING_SOON = "This store is opening soon. Checkout opens when it goes live.";
export const STORE_OFFLINE = "This store is temporarily offline.";

/** Who may check out. Suspended wins over everything; a store in setup is opening soon (#555); then payouts (#4). */
export function checkCheckoutReady(store: {
  status: string;
  stripeOnboardingStatus: OnboardingStatus | string;
}): CheckoutGateResult {
  if (store.status === "suspended") return { enabled: false, message: STORE_OFFLINE };
  if (store.status !== "active") return { enabled: false, message: STORE_OPENING_SOON };
  if (store.stripeOnboardingStatus === "complete") {
    return { enabled: true, message: null };
  }
  return {
    enabled: false,
    message: "This store is not yet accepting online orders",
  };
}

/** Checkout takes real (or harness) payment; otherwise the demo checkout runs. Basket and checkout share it. */
export function checkoutTakesPayment(
  store: { status: string; stripeOnboardingStatus: OnboardingStatus | string },
  publishableKey: string | undefined,
  harness: boolean,
): boolean {
  return checkCheckoutReady(store).enabled && Boolean(publishableKey || harness);
}

/** The e2e Stripe harness is on: its cookie is set and this deployment allows the fake. Basket and checkout share it. */
export function checkoutHarnessOn(cookieStore: { get(name: string): { value: string } | undefined }): boolean {
  return cookieStore.get("e2e_stripe_harness")?.value === "1" && checkoutPaymentsUseFake();
}
