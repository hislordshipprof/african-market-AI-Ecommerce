import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

const BAD = ["/\\evil.com", "/%5Cevil.com", "/%2F%2Fevil.com", "//evil.com", "https://evil.com/"];

function verify(callbackURL: string) {
  const url = new URL("http://localhost:3000/api/auth/magic-link/verify?token=t");
  url.searchParams.set("callbackURL", callbackURL);
  return GET(new NextRequest(url));
}

function send(callbackURL: string) {
  return POST(new NextRequest("http://localhost:3000/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json", "x-store-slug": "mama-ngozi" },
    body: JSON.stringify({ email: "shopper@example.test", callbackURL }),
  }));
}

describe("auth route callbackURL", () => {
  for (const value of BAD) {
    it(`refuses ${JSON.stringify(value)} on GET and POST`, async () => {
      for (const res of [await verify(value), await send(value)]) {
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "callbackURL must be a relative path" });
      }
    });
  }
});

function authPost(path: string, body: unknown, ip: string) {
  return POST(new NextRequest(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  }));
}

describe.skipIf(!process.env.DATABASE_URL)("auth route security events", () => {
  it("a failed password sign-in and a failed TOTP or backup code each log one event, with no email or code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ip = "198.51.100.23";
    const email = `nobody-${Date.now()}@example.test`;
    expect((await authPost("/sign-in/email", { email, password: "wrong-password-1" }, ip)).status).toBe(401);
    expect((await authPost("/two-factor/verify-totp", { code: "123456" }, ip)).status).toBe(401);
    expect((await authPost("/two-factor/verify-backup-code", { code: "abcde-fghij" }, ip)).status).toBe(401);
    // Better Auth also warns in plain text; only the JSON lines are events.
    const events = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    const tag = expect.stringMatching(/^[0-9a-f]{16}$/);
    expect(events).toEqual([
      { event: "auth_sign_in_failed", path: "/sign-in/email", status: 401, ip: tag },
      { event: "auth_two_factor_failed", path: "/two-factor/verify-totp", status: 401, ip: tag },
      { event: "auth_two_factor_failed", path: "/two-factor/verify-backup-code", status: 401, ip: tag },
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of [email, "wrong-password-1", "123456", ip]) expect(logged).not.toContain(secret);
    warn.mockRestore();
  });
});
