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
