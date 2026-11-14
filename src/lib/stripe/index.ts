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
  refundApplicationFeePart: async () => throwUnconfigured(),
  listRefunds: async () => throwUnconfigured(),
  retrieveRefund: async () => throwUnconfigured(),
};

export type StripeSelection = "fake" | "real" | "unconfigured";

export function stripeProviderKind(env: NodeJS.ProcessEnv = process.env): StripeSelection {
  const fake =
    env.E2E_FAKE_STRIPE === "1" &&
    !env.VERCEL &&
    (env.CI === "true" || env.NODE_ENV !== "production");
  if (fake) return "fake";
  const production = env.NODE_ENV === "production" || Boolean(env.VERCEL);
  if (production && !env.STRIPE_SECRET_KEY) return "unconfigured";
  return "real";
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
  if (stripeProviderKind() === "fake") {
    if (!warnedAboutFake) {
      warnedAboutFake = true;
      console.warn(
        "E2E_FAKE_STRIPE=1 is selecting the fake Stripe provider for CI. Refusing this on Vercel and on any other production runtime.",
      );
    }
    _override = fakeStripeProvider;
    return fakeStripeProvider;
  }
  if (stripeProviderKind() === "unconfigured") {
    return unconfiguredStripeProvider;
  }
  return stripeProvider;
}
