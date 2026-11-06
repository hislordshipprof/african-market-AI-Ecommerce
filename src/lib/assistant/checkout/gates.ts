import { readCancelWindow } from "./window";

/**
 * Same exception as the Stripe and assistant fakes: production CI without
 * Vercel may use the fake. Vercel never may, even with CI and the flag set.
 */
export function assistantPaymentsHarness(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL) return false;
  return env.E2E_FAKE_STRIPE === "1" && (env.CI === "true" || env.NODE_ENV !== "production");
}

export function assistantPaymentsReady(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL) return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY);
  const fake = env.E2E_FAKE_STRIPE === "1" && (env.CI === "true" || env.NODE_ENV !== "production");
  if (fake) return true;
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY);
}

export function newCheckoutAllowed(env: NodeJS.ProcessEnv = process.env): { ok: true; minutes: number } | { ok: false; code: "checkout_unavailable" } {
  if (!assistantPaymentsReady(env)) return { ok: false, code: "checkout_unavailable" };
  const window = readCancelWindow(env);
  if (!window.ok) {
    console.error(JSON.stringify({ event: "assistant_cancel_window_invalid" }));
    return { ok: false, code: "checkout_unavailable" };
  }
  return { ok: true, minutes: window.minutes };
}

export const STRIPE_USD_MAX_CENTS = 99_999_999;
export const STRIPE_USD_MIN_CENTS = 50;
