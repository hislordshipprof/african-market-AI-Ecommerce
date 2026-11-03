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
  return stripeProvider;
}
