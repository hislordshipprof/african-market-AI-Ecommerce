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

describe("proxy redirect on ?store= (override allowed)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("E2E_STORE_OVERRIDE", "");
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "");
  });

  it("redirects 307 when ?store= is present and strips the param", () => {
    const req = makeRequest("http://localhost:3000/?store=mama-ngozi");
    const res = proxy(req);
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBeDefined();
    const redirectUrl = new URL(location!);
    expect(redirectUrl.searchParams.has("store")).toBe(false);
    expect(redirectUrl.pathname).toBe("/");
  });

  it("sets store_override cookie on redirect response", () => {
    const req = makeRequest("http://localhost:3000/?store=mama-ngozi");
    const res = proxy(req);
    const cookie = res.cookies.get("store_override");
    expect(cookie).toBeDefined();
    expect(cookie!.value).toBe("mama-ngozi");
  });

  it("preserves other query params in redirect", () => {
    const req = makeRequest(
      "http://localhost:3000/search?store=mama-ngozi&q=rice",
    );
    const res = proxy(req);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.has("store")).toBe(false);
    expect(location.searchParams.get("q")).toBe("rice");
    expect(location.pathname).toBe("/search");
  });

  it("replaces cookie when a new ?store= value is provided", () => {
    const req = makeRequest("http://localhost:3000/?store=tante-marie", {
      store_override: "mama-ngozi",
    });
    const res = proxy(req);
    expect(res.status).toBe(307);
    const cookie = res.cookies.get("store_override");
    expect(cookie!.value).toBe("tante-marie");
  });

  it("sets HttpOnly, SameSite=Lax, Path=/ on the cookie", () => {
    const req = makeRequest("http://localhost:3000/?store=mama-ngozi");
    const res = proxy(req);
    const setCookie = res.headers.getSetCookie();
    const cookieStr = setCookie.find((c) => c.startsWith("store_override="));
    expect(cookieStr).toBeDefined();
    expect(cookieStr).toContain("HttpOnly");
    expect(cookieStr!.toLowerCase()).toContain("samesite=lax");
    expect(cookieStr).toContain("Path=/");
  });

  it("lowercases mixed-case ?store= param", () => {
    const req = makeRequest("http://localhost:3000/?store=Mama-Ngozi");
    const res = proxy(req);
    expect(res.status).toBe(307);
    const cookie = res.cookies.get("store_override");
    expect(cookie!.value).toBe("mama-ngozi");
  });

  it("sets Secure flag on HTTPS requests", () => {
    const req = makeRequest("https://localhost:3000/?store=mama-ngozi");
    const res = proxy(req);
    const setCookie = res.headers.getSetCookie();
    const cookieStr = setCookie.find((c) => c.startsWith("store_override="));
    expect(cookieStr).toContain("Secure");
  });

  it("omits Secure flag on HTTP requests", () => {
    const req = makeRequest("http://localhost:3000/?store=mama-ngozi");
    const res = proxy(req);
    const setCookie = res.headers.getSetCookie();
    const cookieStr = setCookie.find((c) => c.startsWith("store_override="));
    expect(cookieStr).not.toContain("Secure");
  });
});

describe("proxy cookie fallback (override allowed)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("E2E_STORE_OVERRIDE", "");
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "");
  });

  it("falls back to store_override cookie when no query param", () => {
    const req = makeRequest("http://localhost:3000/categories/grains", {
      store_override: "mama-ngozi",
    });
    const res = proxy(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBe(
      "mama-ngozi",
    );
  });

  it("rejects invalid slug in ?store= param (no redirect)", () => {
    const req = makeRequest("http://localhost:3000/?store=../evil");
    const res = proxy(req);
    expect(res.status).toBe(200);
    const cookie = res.cookies.get("store_override");
    expect(cookie).toBeUndefined();
  });

  it("falls back to cookie when ?store= param is invalid", () => {
    const req = makeRequest("http://localhost:3000/?store=../evil", {
      store_override: "mama-ngozi",
    });
    const res = proxy(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBe(
      "mama-ngozi",
    );
  });

  it("rejects reserved slug in ?store= param (no redirect)", () => {
    const req = makeRequest("http://localhost:3000/?store=admin");
    const res = proxy(req);
    expect(res.status).toBe(200);
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
});

describe("proxy in hosted CI (e2e override, no Vercel)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("E2E_STORE_OVERRIDE", "1");
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "example.com");
  });

  it("ignores a forged store header and keeps the host", () => {
    const req = new NextRequest("http://mama-ngozi.example.com/", {
      headers: { host: "mama-ngozi.example.com", "x-store-slug": "tante-marie" },
    });
    const res = proxy(req);
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBe("mama-ngozi");
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

  it("ignores ?store= param in production (no redirect)", () => {
    const req = makeRequest("http://example.com/?store=mama-ngozi");
    const res = proxy(req);
    expect(res.status).toBe(200);
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

  it("production host wins over a forged store header and disallowed overrides", () => {
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "example.com");
    const req = new NextRequest("http://mama-ngozi.example.com/categories/grains?store=tante-marie", {
      headers: { host: "mama-ngozi.example.com", "x-store-slug": "tante-marie" },
    });
    req.cookies.set("store_override", "tante-marie");
    const res = proxy(req);
    expect(res.status).toBe(200);
    expect(res.cookies.get("store_override")).toBeUndefined();
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBe("mama-ngozi");
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

describe("security headers on the proxy", () => {
  it("redirect and pass-through both carry headers", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("E2E_STORE_OVERRIDE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    const redirect = proxy(makeRequest("http://localhost:3000/?store=mama-ngozi"));
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(redirect.headers.get("content-security-policy")).toContain("report-uri /api/csp-report");
    expect(redirect.headers.get("content-security-policy-report-only")).toContain("default-src 'self'");
    expect(redirect.headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains");

    vi.stubEnv("NODE_ENV", "production");
    const pass = proxy(makeRequest("http://localhost:3000/"));
    expect(pass.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pass.headers.get("x-frame-options")).toBe("DENY");
    expect(pass.headers.get("content-security-policy-report-only")).not.toContain("unsafe-eval");
    expect(pass.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(pass.headers.get("permissions-policy")).toContain("camera=()");

    const nextConfig = (await import("../next.config")).default;
    if (!nextConfig.headers) throw new Error("next config does not set headers");
    const configured = await nextConfig.headers();
    expect(configured.map((entry: { source: string }) => entry.source)).toContain("/_next/static/:path*");
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("an SVG path gets a no-script, sandboxed policy (#124)", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const path of [
      "/logos/mama-ngozi-logo.svg",
      "/api/catalog-image/catalog/logo.svg",
      "/logos/mama-ngozi-logo%2Esvg",
      "/logos/mama-ngozi-logo%2esvg",
      "/logos/mama-ngozi-logo.sv%67",
      "/logos/bad%E0%A4%A.png",
    ]) {
      const res = proxy(makeRequest(`http://localhost:3000${path}`));
      expect(res.headers.get("content-security-policy")).toMatch(/script-src 'none'.*sandbox/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("every catalog-image path gets the no-script policy, whatever its extension (#124)", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const path of ["/api/catalog-image/catalog/x.jpg", "/api/catalog%2Dimage/catalog/x.jpg"]) {
      const res = proxy(makeRequest(`http://localhost:3000${path}`));
      expect(res.headers.get("content-security-policy")).toMatch(/script-src 'none'.*sandbox/);
    }
  });

  it("nonce request equals response and differs per request", () => {
    vi.stubEnv("NODE_ENV", "production");
    const first = proxy(makeRequest("http://localhost:3000/shop"));
    const second = proxy(makeRequest("http://localhost:3000/shop"));
    const report = (response: { headers: { get(name: string): string | null } }) =>
      response.headers.get("content-security-policy-report-only");
    expect(report(first)).toBe(first.headers.get("x-middleware-request-content-security-policy-report-only"));
    expect(report(first)).not.toBe(report(second));
    expect(first.headers.get("content-security-policy")).not.toContain("nonce-");
  });
});

describe("proxy custom domain resolution", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("E2E_STORE_OVERRIDE", "");
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "markets.example");
  });

  it("forwards a non-platform host as x-custom-domain, not as a slug", () => {
    const res = proxy(makeRequest("https://Shop.MamasMarket.com/"));
    expect(res.headers.get("x-middleware-request-x-custom-domain")).toBe("shop.mamasmarket.com");
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBeNull();
  });

  it("keeps platform subdomains on the slug path", () => {
    const res = proxy(makeRequest("https://mama-ngozi.markets.example/"));
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBe("mama-ngozi");
    expect(res.headers.get("x-middleware-request-x-custom-domain")).toBeNull();
  });

  it("drops a client-sent x-custom-domain on a platform host", () => {
    const req = new NextRequest("https://markets.example/", {
      headers: { host: "markets.example", "x-custom-domain": "victim-store.com" },
    });
    const res = proxy(req);
    expect(res.headers.get("x-middleware-request-x-custom-domain")).toBeNull();
  });
});

describe("proxy on the platform root domain (store directory)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("E2E_STORE_OVERRIDE", "");
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "example.com");
  });

  for (const host of ["example.com", "www.example.com"]) {
    it(`marks ${host} as the platform root and sets no store`, () => {
      const res = proxy(makeRequest(`http://${host}/`));
      expect(res.headers.get("x-middleware-request-x-platform-root")).toBe("1");
      expect(res.headers.get("x-middleware-request-x-store-slug")).toBeNull();
      expect(res.headers.get("x-middleware-request-x-custom-domain")).toBeNull();
    });
  }

  it("leaves a store host unmarked and drops a forged root header", () => {
    const req = new NextRequest("http://mama-ngozi.example.com/", {
      headers: { host: "mama-ngozi.example.com", "x-platform-root": "1" },
    });
    const res = proxy(req);
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBe("mama-ngozi");
    expect(res.headers.get("x-middleware-request-x-platform-root")).toBeNull();
  });

  for (const path of ["/stores/texas", "/stores/texas/houston", "/sitemap.xml", "/robots.txt"]) {
    it(`serves ${path} on the root domain`, () => {
      const res = proxy(makeRequest(`http://example.com${path}`));
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    });

    it(`answers ${path} with not found on a store host`, () => {
      const res = proxy(makeRequest(`http://mama-ngozi.example.com${path}`));
      expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/_directory-not-here");
    });
  }

  it("the not-found rewrite forwards the sanitised headers, so a forged x-store-slug never reaches the render", () => {
    const req = new NextRequest("http://unknown-host.test/stores/texas", {
      headers: { host: "unknown-host.test", "x-store-slug": "victim-store", "x-platform-root": "1" },
    });
    const res = proxy(req);
    expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/_directory-not-here");
    const forwarded = res.headers.get("x-middleware-override-headers")?.split(",") ?? [];
    expect(forwarded).toContain("host");
    expect(forwarded).not.toContain("x-store-slug");
    expect(forwarded).not.toContain("x-platform-root");
    expect(res.headers.get("x-middleware-request-x-store-slug")).toBeNull();
  });

  it("leaves a store's own /stores-like paths alone", () => {
    const res = proxy(makeRequest("http://mama-ngozi.example.com/storesx"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

describe("directory attribution cookie (#454)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "example.com");
  });

  it("sets a 30-day first-party cookie holding only the word directory when a store link carries ?ref=directory", () => {
    const res = proxy(makeRequest("https://mama-ngozi.example.com/?ref=directory"));
    const cookie = res.cookies.get("came_from");
    expect(cookie?.value).toBe("directory");
    expect(cookie?.maxAge).toBe(60 * 60 * 24 * 30);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.secure).toBe(true);
    expect(cookie?.domain).toBeUndefined();
  });

  it("sets it on a store's own domain too", () => {
    const res = proxy(makeRequest("https://mamangozi.com/?ref=directory"));
    expect(res.cookies.get("came_from")?.value).toBe("directory");
  });

  it("does not set the cookie without the ref", () => {
    const res = proxy(makeRequest("https://mama-ngozi.example.com/"));
    expect(res.cookies.get("came_from")).toBeUndefined();
  });

  it("does not set the cookie for any other ref value", () => {
    for (const ref of ["Directory", "directory2", "xdirectory", ""]) {
      const res = proxy(makeRequest(`https://mama-ngozi.example.com/?ref=${ref}`));
      expect(res.cookies.get("came_from")).toBeUndefined();
    }
  });

  it("does not set the cookie on the directory itself", () => {
    const res = proxy(makeRequest("https://example.com/?ref=directory"));
    expect(res.cookies.get("came_from")).toBeUndefined();
  });
});
