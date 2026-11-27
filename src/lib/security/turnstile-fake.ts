import { vi } from "vitest";

/** Cloudflare's published test keys (#872): never a real key in the repo. */
export const TURNSTILE_TEST_KEYS = {
  site: "1x00000000000000000000AA",
  pass: "1x0000000000000000000000000000000AA",
  fail: "2x0000000000000000000000000000000AA",
};

/**
 * Sets both keys and answers siteverify as Cloudflare does for its test secrets; "down" throws like an outage.
 * Every other request goes to the real fetch. Undo with vi.unstubAllEnvs() and vi.unstubAllGlobals().
 */
export function stubTurnstile(secret: "pass" | "fail" | "down"): void {
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", TURNSTILE_TEST_KEYS.site);
  vi.stubEnv("TURNSTILE_SECRET_KEY", secret === "fail" ? TURNSTILE_TEST_KEYS.fail : TURNSTILE_TEST_KEYS.pass);
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input instanceof Request ? input.url : input).includes("challenges.cloudflare.com")) return real(input, init);
    if (secret === "down") throw new TypeError("fetch failed");
    const passed = secret === "pass" && new URLSearchParams(String(init?.body)).get("response") === "XXXX.DUMMY.TOKEN.XXXX";
    return Response.json(passed
      ? { success: true, challenge_ts: new Date().toISOString(), hostname: "example.com", "error-codes": [] }
      : { success: false, "error-codes": ["invalid-input-response"] });
  });
}

export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
