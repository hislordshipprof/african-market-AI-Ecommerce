import { afterEach, describe, expect, it, vi } from "vitest";
import { turnstileSiteKey, verifyTurnstile } from "./turnstile";

const PASS_SITE = "1x00000000000000000000AA";
const PASS_SECRET = "1x0000000000000000000000000000000AA";
const REAL_SECRET = "0x4AAAAAAAreal-secret-value";
const KEYS = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: PASS_SITE, TURNSTILE_SECRET_KEY: REAL_SECRET };

function answer(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

const check = { ip: "203.0.113.9", host: "shop.globegrocer.com:443" };

afterEach(() => vi.restoreAllMocks());

describe("turnstile", () => {
  it("is off, with no widget and no siteverify call, while either key is unset", async () => {
    const fetch = answer({ success: false });
    for (const env of [{}, { NEXT_PUBLIC_TURNSTILE_SITE_KEY: PASS_SITE }, { TURNSTILE_SECRET_KEY: REAL_SECRET, NEXT_PUBLIC_TURNSTILE_SITE_KEY: " " }]) {
      expect(turnstileSiteKey(env)).toBeNull();
      expect(await verifyTurnstile(null, check, { env, fetch })).toEqual({ ok: true });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(turnstileSiteKey(KEYS)).toBe(PASS_SITE);
  });

  it("rejects a missing token without calling siteverify", async () => {
    const fetch = answer({ success: true, hostname: "shop.globegrocer.com" });
    expect(await verifyTurnstile("", check, { env: KEYS, fetch })).toEqual({ ok: false, reason: "missing" });
    expect(await verifyTurnstile(undefined, check, { env: KEYS, fetch })).toEqual({ ok: false, reason: "missing" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the secret, token and client IP, and accepts success on the request's host", async () => {
    const fetch = answer({ success: true, hostname: "shop.globegrocer.com" });
    expect(await verifyTurnstile("tok", check, { env: KEYS, fetch })).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("secret")).toBe(REAL_SECRET);
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("203.0.113.9");
  });

  it("rejects success on another hostname, and a failed token", async () => {
    expect(await verifyTurnstile("tok", check, { env: KEYS, fetch: answer({ success: true, hostname: "evil.example" }) }))
      .toEqual({ ok: false, reason: "rejected" });
    expect(await verifyTurnstile("tok", check, { env: KEYS, fetch: answer({ success: false, "error-codes": ["invalid-input-response"] }) }))
      .toEqual({ ok: false, reason: "rejected" });
  });

  it("accepts Cloudflare's test secret, whose answers always name example.com", async () => {
    const env = { ...KEYS, TURNSTILE_SECRET_KEY: PASS_SECRET };
    expect(await verifyTurnstile("XXXX.DUMMY.TOKEN.XXXX", check, { env, fetch: answer({ success: true, hostname: "example.com" }) }))
      .toEqual({ ok: true });
  });

  it("reports siteverify being unreachable, a 5xx, or a garbled answer as unavailable, and never logs the secret or token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await verifyTurnstile("tok-secret-value", check, { env: KEYS, fetch: down })).toEqual({ ok: false, reason: "unavailable" });
    expect(await verifyTurnstile("tok", check, { env: KEYS, fetch: answer({}, 503) })).toEqual({ ok: false, reason: "unavailable" });
    const garbled = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect(await verifyTurnstile("tok", check, { env: KEYS, fetch: garbled })).toEqual({ ok: false, reason: "unavailable" });
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("turnstile_unavailable");
    expect(logged).not.toContain(REAL_SECRET);
    expect(logged).not.toContain("tok-secret-value");
  });
});
