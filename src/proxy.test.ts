import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { allowStoreOverride, proxy } from "./proxy";

describe("allowStoreOverride", () => {
  it("returns true for VERCEL_ENV=preview", () => {
    expect(allowStoreOverride({ VERCEL_ENV: "preview" })).toBe(true);
  });

  it("returns true for NODE_ENV=development", () => {
    expect(allowStoreOverride({ NODE_ENV: "development" })).toBe(true);
  });

  it("returns false for VERCEL_ENV=production", () => {
    expect(allowStoreOverride({ VERCEL_ENV: "production" })).toBe(false);
  });

  it("returns false for NODE_ENV=production with VERCEL_ENV unset", () => {
    expect(allowStoreOverride({ NODE_ENV: "production" })).toBe(false);
  });

  it("returns true for E2E_STORE_OVERRIDE=1 outside Vercel", () => {
    expect(
      allowStoreOverride({
        NODE_ENV: "production",
        E2E_STORE_OVERRIDE: "1",
      }),
    ).toBe(true);
  });

  it("returns false for E2E_STORE_OVERRIDE=1 on Vercel", () => {
    expect(
      allowStoreOverride({
        NODE_ENV: "production",
        E2E_STORE_OVERRIDE: "1",
        VERCEL: "1",
      }),
    ).toBe(false);
  });

  it("returns false when both are unset", () => {
    expect(allowStoreOverride({})).toBe(false);
  });
});

function makeRequest(
  url: string,
  cookies?: Record<string, string>,
): NextRequest {
  const parsed = new URL(url);
  const req = new NextRequest(url, {
    headers: { host: parsed.host },
  });
  if (cookies) {
    for (const [name, value] of Object.entries(cookies)) {
      req.cookies.set(name, value);
    }
  }
  return req;
}

describe("proxy cookie persistence (override allowed)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("E2E_STORE_OVERRIDE", "");
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "");
  });

  it("sets store_override cookie when ?store= is present", () => {
    const req = makeRequest("http://localhost:3000/?store=mama-ngozi");
    const res = proxy(req);
    const cookie = res.cookies.get("store_override");
    expect(cookie).toBeDefined();
    expect(cookie!.value).toBe("mama-ngozi");
  });

  it("sets x-store-slug header from ?store= param", () => {
    const req = makeRequest("http://localhost:3000/?store=mama-ngozi");
    const res = proxy(req);
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBe(
      "mama-ngozi",
    );
  });

  it("falls back to store_override cookie when no query param", () => {
    const req = makeRequest("http://localhost:3000/categories/grains", {
      store_override: "mama-ngozi",
    });
    const res = proxy(req);
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBe(
      "mama-ngozi",
    );
  });

  it("replaces cookie when a new ?store= value is provided", () => {
    const req = makeRequest("http://localhost:3000/?store=tante-marie", {
      store_override: "mama-ngozi",
    });
    const res = proxy(req);
    const cookie = res.cookies.get("store_override");
    expect(cookie!.value).toBe("tante-marie");
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBe(
      "tante-marie",
    );
  });

  it("rejects invalid slug in ?store= param", () => {
    const req = makeRequest("http://localhost:3000/?store=../evil");
    const res = proxy(req);
    const cookie = res.cookies.get("store_override");
    expect(cookie).toBeUndefined();
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBeNull();
  });

  it("rejects reserved slug in ?store= param", () => {
    const req = makeRequest("http://localhost:3000/?store=admin");
    const res = proxy(req);
    const cookie = res.cookies.get("store_override");
    expect(cookie).toBeUndefined();
  });

  it("rejects invalid slug in cookie", () => {
    const req = makeRequest("http://localhost:3000/", {
      store_override: "<script>alert(1)</script>",
    });
    const res = proxy(req);
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBeNull();
  });

  it("sets HttpOnly, SameSite=Lax, Path=/ on the cookie", () => {
    const req = makeRequest("http://localhost:3000/?store=mama-ngozi");
    const res = proxy(req);
    const cookie = res.cookies.get("store_override");
    expect(cookie).toBeDefined();
    const setCookie = res.headers.getSetCookie();
    const cookieStr = setCookie.find((c) => c.startsWith("store_override="));
    expect(cookieStr).toBeDefined();
    expect(cookieStr).toContain("HttpOnly");
    expect(cookieStr!.toLowerCase()).toContain("samesite=lax");
    expect(cookieStr).toContain("Path=/");
  });
});

describe("proxy in production (override not allowed)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("E2E_STORE_OVERRIDE", "");
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "");
  });

  it("ignores ?store= param in production", () => {
    const req = makeRequest("http://example.com/?store=mama-ngozi");
    const res = proxy(req);
    const cookie = res.cookies.get("store_override");
    expect(cookie).toBeUndefined();
  });

  it("ignores store_override cookie in production", () => {
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "example.com");
    const req = makeRequest("http://example.com/categories/grains", {
      store_override: "mama-ngozi",
    });
    const res = proxy(req);
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBeNull();
  });

  it("still resolves slug from host in production", () => {
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "example.com");
    const req = makeRequest("http://mama-ngozi.example.com/");
    const res = proxy(req);
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBe(
      "mama-ngozi",
    );
  });
});
