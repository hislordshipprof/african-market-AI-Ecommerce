import type { StripeProvider } from "./types";
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

export function getStripeProvider(): StripeProvider {
  if (_override) return _override;
  // A production process with no key must fail at call time. Never substitute the fake.
  if (isProductionRuntime() && !process.env.STRIPE_SECRET_KEY) {
    return unconfiguredStripeProvider;
  }
  // Vercel is a real deploy even if someone sets the e2e flag. Local `next start`
  // is also NODE_ENV=production, and e2e opts into the fake explicitly.
  if (process.env.E2E_FAKE_STRIPE === "1" && !process.env.VERCEL) {
    if (!warnedAboutFake) {
      warnedAboutFake = true;
      console.warn(
        "E2E_FAKE_STRIPE=1 is selecting the fake Stripe provider. Refusing this on Vercel.",
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fakeStripeProvider } = require("./fake") as typeof import("./fake");
    _override = fakeStripeProvider;
    return fakeStripeProvider;
  }
  return stripeProvider;
}
