import { checkoutPaymentsUseFake } from "./checkout-payments";
import type { OnboardingStatus } from "./types";

export interface CheckoutGateResult {
  enabled: boolean;
  message: string | null;
}

export function checkCheckoutReady(
  stripeOnboardingStatus: OnboardingStatus | string,
): CheckoutGateResult {
  if (stripeOnboardingStatus === "complete") {
    return { enabled: true, message: null };
  }
  return {
    enabled: false,
    message: "This store is not yet accepting online orders",
  };
}

/** Checkout takes real (or harness) payment; otherwise the demo checkout runs. Basket and checkout share it. */
export function checkoutTakesPayment(
  stripeOnboardingStatus: OnboardingStatus | string,
  publishableKey: string | undefined,
  harness: boolean,
): boolean {
  return checkCheckoutReady(stripeOnboardingStatus).enabled && Boolean(publishableKey || harness);
}

/** The e2e Stripe harness is on: its cookie is set and this deployment allows the fake. Basket and checkout share it. */
export function checkoutHarnessOn(cookieStore: { get(name: string): { value: string } | undefined }): boolean {
  return cookieStore.get("e2e_stripe_harness")?.value === "1" && checkoutPaymentsUseFake();
}
