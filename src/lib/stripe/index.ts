import type { StripeProvider } from "./types";
import { stripeProvider } from "./provider";

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

export function getStripeProvider(): StripeProvider {
  if (_override) return _override;
  if (process.env.E2E_FAKE_STRIPE === "1" && !process.env.VERCEL) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fakeStripeProvider } = require("./fake") as typeof import("./fake");
    _override = fakeStripeProvider;
    return fakeStripeProvider;
  }
  return stripeProvider;
}
