import type { StripeProvider } from "./types";
import { fakeStripeProvider } from "./fake";
import { stripeProvider } from "./provider";

const UNCONFIGURED_MESSAGE =
  "Stripe is not configured: STRIPE_SECRET_KEY is missing in production. Refusing to fall back to the fake provider.";

function throwUnconfigured(): never {
  throw new Error(UNCONFIGURED_MESSAGE);
}

const unconfiguredStripeProvider: StripeProvider = {
  createConnectAccount: async () => throwUnconfigured(),
  createAccountLink: async () => throwUnconfigured(),
  getAccount: async () => throwUnconfigured(),
  verifyWebhookSignature: () => throwUnconfigured(),
  capturePaymentIntent: async () => throwUnconfigured(),
  cancelPaymentIntent: async () => throwUnconfigured(),
  retrievePaymentIntent: async () => throwUnconfigured(),
  refundPayment: async () => throwUnconfigured(),
  listRefunds: async () => throwUnconfigured(),
  retrieveRefund: async () => throwUnconfigured(),
};

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}

export type { StripeProvider } from "./types";
export type {
  OnboardingStatus,
  ConnectAccount,
  AccountLinkResult,
  WebhookEvent,
  CaptureResult,
  CancelResult,
  RetrieveResult,
} from "./types";
export { deriveOnboardingStatus } from "./types";

let _override: StripeProvider | null = null;

export function setStripeProvider(provider: StripeProvider | null): void {
  _override = provider;
}

let warnedAboutFake = false;

// Production may use the fake only for CI e2e: the flag, CI=true, and not Vercel.
// GitHub Actions sets CI. Any other production runtime with no key fails at call time.
function ciE2EFakeAllowed(): boolean {
  return (
    process.env.E2E_FAKE_STRIPE === "1" &&
    process.env.CI === "true" &&
    !process.env.VERCEL
  );
}

function devFakeAllowed(): boolean {
  return process.env.E2E_FAKE_STRIPE === "1" && !process.env.VERCEL && !isProductionRuntime();
}

export function getStripeProvider(): StripeProvider {
  if (_override) return _override;
  if (ciE2EFakeAllowed() || devFakeAllowed()) {
    if (!warnedAboutFake) {
      warnedAboutFake = true;
      console.warn(
        "E2E_FAKE_STRIPE=1 is selecting the fake Stripe provider for CI. Refusing this on Vercel and on any other production runtime.",
      );
    }
    _override = fakeStripeProvider;
    return fakeStripeProvider;
  }
  if (isProductionRuntime() && !process.env.STRIPE_SECRET_KEY) {
    return unconfiguredStripeProvider;
  }
  return stripeProvider;
}
