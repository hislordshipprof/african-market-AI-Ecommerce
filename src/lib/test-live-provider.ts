import type { TestContext } from "vitest";

/**
 * Live provider sandbox tests (`*sandbox*.test.ts`) run only with LIVE_SANDBOX=1, so CI does not spend the
 * providers' quotas on every run. scripts/ci-main.sh sets it at most once a UTC day (#591).
 */
export const liveSandbox = process.env.LIVE_SANDBOX === "1";

/** The provider refused for our account's quota or rate limit (HTTP 429), not because of our code. */
export function isProviderQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Uber Direct and Telnyx carry `status`, Stripe and the AI SDK (Anthropic) `statusCode`; Resend has only the message.
  const { status, statusCode, type } = error as { status?: unknown; statusCode?: unknown; type?: unknown };
  return status === 429 || statusCode === 429 || type === "StripeRateLimitError" || /^Resend API error 429:/.test(error.message);
}

/**
 * Wraps a provider's sandbox tests and hooks: a quota or rate-limit refusal is reported as skipped with a warning
 * naming the provider, never as a pass or a failure. After a refusal the provider's later tests skip too.
 */
export function providerSandbox(provider: string) {
  let refused: string | null = null;
  function note(error: unknown): void {
    if (refused || !isProviderQuotaError(error)) return;
    refused = (error as Error).message.slice(0, 120);
    console.warn(`${provider} sandbox skipped: provider quota or rate limit reached (${refused})`);
  }
  return {
    test: (body: (ctx: TestContext) => unknown) => async (ctx: TestContext) => {
      if (refused) ctx.skip();
      try {
        await body(ctx);
      } catch (error) {
        note(error);
        if (!refused) throw error;
      }
      if (refused) ctx.skip();
    },
    hook: (body: () => unknown) => async () => {
      try {
        await body();
      } catch (error) {
        note(error);
        if (!refused) throw error;
      }
    },
    /** Notes a refusal that an expected-rejection assertion would otherwise swallow, then passes the promise on. */
    watch: <T>(promise: Promise<T>) => promise.catch((error: unknown) => {
      note(error);
      throw error;
    }),
  };
}
