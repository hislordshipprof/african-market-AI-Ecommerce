/**
 * No real-money order until tax sign-off (ADR-0008). Live Stripe keys work only
 * when CHECKOUT_LIVE_MODE is exactly "true". A live/test mix always fails.
 * Reads process.env at call time, never at import, and never logs a key value.
 */
export const LIVE_MODE_BLOCKED_MESSAGE = "This store isn't taking online payments yet.";

type KeyMode = "test" | "live" | "missing";
export type LiveModeBlockReason = "live_without_flag" | "mixed_keys";
export type LiveModeCheck = { ok: true } | { ok: false; reason: LiveModeBlockReason };

function secretKeyMode(key: string | undefined): KeyMode {
  if (!key) return "missing";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  // sk_live_, rk_live_, sk_org_ and anything unknown fail safe as live.
  return "live";
}

function publishableKeyMode(key: string | undefined): KeyMode {
  if (!key) return "missing";
  return key.startsWith("pk_test_") ? "test" : "live";
}

export function checkLiveMode(env: NodeJS.ProcessEnv = process.env): LiveModeCheck {
  const secret = secretKeyMode(env.STRIPE_SECRET_KEY);
  const publishable = publishableKeyMode(env.STRIPE_PUBLISHABLE_KEY);
  // Missing is never "mixed": CI and Playwright run with an empty secret key and the fake provider.
  if ((secret === "test" && publishable === "live") || (secret === "live" && publishable === "test")) {
    return { ok: false, reason: "mixed_keys" };
  }
  if ((secret === "live" || publishable === "live") && env.CHECKOUT_LIVE_MODE !== "true") {
    return { ok: false, reason: "live_without_flag" };
  }
  return { ok: true };
}

export class LiveModeBlockedError extends Error {
  readonly code = "checkout_live_mode_blocked" as const;
  constructor(readonly reason: LiveModeBlockReason) {
    super(LIVE_MODE_BLOCKED_MESSAGE);
    this.name = "LiveModeBlockedError";
  }
}

const logged = new Set<LiveModeBlockReason>();

/** Logs each reason once per process. */
export function liveModeCheck(): LiveModeCheck {
  const result = checkLiveMode();
  if (!result.ok && !logged.has(result.reason)) {
    logged.add(result.reason);
    console.error(JSON.stringify({ event: "checkout_live_mode_blocked", reason: result.reason }));
  }
  return result;
}

/** First statement of every checkout entry point that can reach Stripe. */
export function assertLiveModeAllowed(): void {
  const result = liveModeCheck();
  if (!result.ok) throw new LiveModeBlockedError(result.reason);
}
