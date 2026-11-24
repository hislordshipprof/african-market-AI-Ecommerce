import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getIP } from "better-auth/api";

const {
  mockUserFindUnique,
  mockUserFindFirst,
  mockSessionDeleteMany,
  mockMembershipFindMany,
  mockSendEmail,
} = vi.hoisted(() => ({
  mockUserFindUnique: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockSessionDeleteMany: vi.fn(),
  mockMembershipFindMany: vi.fn(),
  mockSendEmail: vi.fn(() => Promise.resolve()),
}));

vi.mock("./db", () => ({
  authPrisma: {
    user: { findUnique: mockUserFindUnique, findFirst: mockUserFindFirst },
    session: { deleteMany: mockSessionDeleteMany },
  },
  platformAdmin: {
    storeMembership: { findMany: mockMembershipFindMany },
  },
}));

vi.mock("./email/send", () => ({
  sendEmail: mockSendEmail,
}));

import {
  auth,
  resolveAuthBaseUrl,
  resolveAuthAllowedHosts,
  resolveAuthRateLimitRelaxed,
  resolveAuthSecureCookies,
  resolveAuthTrustedOrigins,
  validateAuthSecret,
} from "./auth";
import { magicLinkMessage } from "./magic-link-mail";

describe("auth config", () => {
  it("has session cookie cache disabled globally", () => {
    const opts = auth.options as Record<string, unknown>;
    const session = opts.session as Record<string, unknown>;
    const cookieCache = session.cookieCache as Record<string, unknown>;
    expect(cookieCache.enabled).toBe(false);
  });

  it("baseURL is built from the resolvers, with a fallback so unknown hosts do not 500", () => {
    const opts = auth.options as Record<string, unknown>;
    expect(opts.baseURL).toEqual({
      allowedHosts: resolveAuthAllowedHosts(),
      protocol: "auto",
      fallback: resolveAuthBaseUrl(),
    });
  });
});

describe("magicLinkMessage", () => {
  it("a hostile store name cannot inject markup, headers or a second sender", () => {
    const message = magicLinkMessage({
      to: "ada@example.com",
      url: "https://shop.example/api/auth/magic-link/verify?token=t&callbackURL=/account",
      storeName: 'Evil</p><script>alert(1)</script>, "Shop"\r\nBcc: x@evil.example',
      fromAddress: "Markets <signin@markets.example>",
    });
    expect(message.html).not.toMatch(/<script|<\/p><script/i);
    expect(message.html).toContain("token=t&amp;callbackURL=/account");
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.from).not.toMatch(/[\r\n]/);
    expect(message.from).toMatch(/^"[^"]*" <signin@markets\.example>$/);
  });
});

describe("resolveAuthBaseUrl", () => {
  it("returns BETTER_AUTH_URL when set", () => {
    expect(
      resolveAuthBaseUrl({ BETTER_AUTH_URL: "https://custom.example.com" }),
    ).toBe("https://custom.example.com");
  });

  it("falls back to https://$VERCEL_URL on Vercel", () => {
    expect(
      resolveAuthBaseUrl({ VERCEL_URL: "my-app-abc123.vercel.app" }),
    ).toBe("https://my-app-abc123.vercel.app");
  });

  it("prefers BETTER_AUTH_URL over VERCEL_URL", () => {
    expect(
      resolveAuthBaseUrl({
        BETTER_AUTH_URL: "https://custom.example.com",
        VERCEL_URL: "my-app-abc123.vercel.app",
      }),
    ).toBe("https://custom.example.com");
  });

  it("defaults to http://localhost:3000 when nothing is set", () => {
    expect(resolveAuthBaseUrl({})).toBe("http://localhost:3000");
  });
});

describe("resolveAuthAllowedHosts", () => {
  it("includes localhost by default", () => {
    const hosts = resolveAuthAllowedHosts({});
    expect(hosts).toContain("localhost:3000");
    expect(hosts).toContain("*.localhost:3000");
  });

  it("includes BETTER_AUTH_URL host and wildcard subdomain", () => {
    const hosts = resolveAuthAllowedHosts({
      BETTER_AUTH_URL: "https://platform.example.com",
    });
    expect(hosts).toContain("platform.example.com");
    expect(hosts).toContain("*.platform.example.com");
  });

  it("includes VERCEL_URL and wildcard", () => {
    const hosts = resolveAuthAllowedHosts({
      VERCEL_URL: "my-app.vercel.app",
    });
    expect(hosts).toContain("my-app.vercel.app");
    expect(hosts).toContain("*.my-app.vercel.app");
  });

  it("includes custom PORT", () => {
    const hosts = resolveAuthAllowedHosts({ PORT: "3200" });
    expect(hosts).toContain("localhost:3200");
    expect(hosts).toContain("*.localhost:3200");
    expect(hosts).toContain("localhost:3000");
  });

  it("deduplicates hosts", () => {
    const hosts = resolveAuthAllowedHosts({
      BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
    });
    const count = hosts.filter((h) => h === "localhost:3000").length;
    expect(count).toBe(1);
  });

  it("includes PLATFORM_ROOT_DOMAIN and wildcard", () => {
    const hosts = resolveAuthAllowedHosts({
      PLATFORM_ROOT_DOMAIN: "africanmarkets.com",
    });
    expect(hosts).toContain("africanmarkets.com");
    expect(hosts).toContain("*.africanmarkets.com");
  });

  it("includes 127.0.0.1 on default port", () => {
    const hosts = resolveAuthAllowedHosts({});
    expect(hosts).toContain("127.0.0.1:3000");
  });

  it("includes 127.0.0.1 on custom port", () => {
    const hosts = resolveAuthAllowedHosts({ PORT: "3200" });
    expect(hosts).toContain("127.0.0.1:3200");
    expect(hosts).toContain("127.0.0.1:3000");
  });
});

describe("resolveAuthTrustedOrigins", () => {
  it("always includes localhost origins", () => {
    const origins = resolveAuthTrustedOrigins({});
    expect(origins).toContain("http://localhost:3000");
    expect(origins).toContain("http://*.localhost:3000");
  });

  it("includes VERCEL_URL as https origin", () => {
    const origins = resolveAuthTrustedOrigins({
      VERCEL_URL: "my-app-abc123.vercel.app",
    });
    expect(origins).toContain("https://my-app-abc123.vercel.app");
  });

  it("parses comma-separated BETTER_AUTH_TRUSTED_ORIGINS", () => {
    const origins = resolveAuthTrustedOrigins({
      BETTER_AUTH_TRUSTED_ORIGINS: "https://a.com, https://b.com",
    });
    expect(origins).toContain("https://a.com");
    expect(origins).toContain("https://b.com");
  });

  it("deduplicates origins", () => {
    const origins = resolveAuthTrustedOrigins({
      BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
    });
    const localhostCount = origins.filter(
      (o) => o === "http://localhost:3000",
    ).length;
    expect(localhostCount).toBe(1);
  });

  it("includes PORT-based wildcard origins", () => {
    const origins = resolveAuthTrustedOrigins({ PORT: "3200" });
    expect(origins).toContain("http://localhost:3200");
    expect(origins).toContain("http://*.localhost:3200");
    expect(origins).toContain("http://localhost:3000");
    expect(origins).toContain("http://*.localhost:3000");
  });

  it("uses port 3000 when PORT is not set", () => {
    const origins = resolveAuthTrustedOrigins({});
    expect(origins).toContain("http://localhost:3000");
    expect(origins).toContain("http://*.localhost:3000");
  });

  it("trusts the production alias exactly, with no wildcard, until PLATFORM_ROOT_DOMAIN is set (#766)", () => {
    const alias = "african-market-ai-ecommerce.vercel.app";
    const env = { VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: alias };
    expect(resolveAuthTrustedOrigins(env)).toContain(`https://${alias}`);
    const hosts = resolveAuthAllowedHosts(env);
    expect(hosts).toContain(alias);
    expect(hosts).not.toContain(`*.${alias}`);

    const withRoot = { ...env, PLATFORM_ROOT_DOMAIN: "africanmarkets.com" };
    expect(resolveAuthTrustedOrigins(withRoot)).not.toContain(`https://${alias}`);
    expect(resolveAuthAllowedHosts(withRoot)).not.toContain(alias);
  });

  it("ignores empty entries in BETTER_AUTH_TRUSTED_ORIGINS", () => {
    const origins = resolveAuthTrustedOrigins({
      BETTER_AUTH_TRUSTED_ORIGINS: "https://a.com,,, ",
    });
    expect(origins).toContain("https://a.com");
    expect(origins).not.toContain("");
  });
});

describe("C1: session.create.before hook", () => {
  function getHookBefore() {
    const opts = auth.options as Record<string, unknown>;
    const hooks = opts.databaseHooks as Record<string, unknown>;
    const session = hooks.session as Record<string, unknown>;
    const create = session.create as Record<string, unknown>;
    return create.before as (
      session: { userId: string },
      ctx?: Record<string, unknown>,
    ) => Promise<{ data: { twoFactorVerified: boolean } } | undefined>;
  }

  beforeEach(() => {
    mockUserFindUnique.mockReset();
    mockUserFindFirst.mockReset();
    mockMembershipFindMany.mockReset();
  });

  it("sets twoFactorVerified=true for /two-factor/ path", async () => {
    mockUserFindUnique.mockResolvedValueOnce({ twoFactorEnabled: true });
    const result = await getHookBefore()(
      { userId: "user-1" },
      { path: "/two-factor/verify-totp" },
    );
    expect(result).toEqual({ data: { twoFactorVerified: true } });
  });

  it("does NOT set twoFactorVerified for /sign-in/magic-link path", async () => {
    mockUserFindUnique.mockResolvedValueOnce({ twoFactorEnabled: true });
    const result = await getHookBefore()(
      { userId: "user-1" },
      { path: "/sign-in/magic-link" },
    );
    expect(result).toBeUndefined();
  });

  it("does NOT set twoFactorVerified for /sign-in/email path", async () => {
    mockUserFindUnique.mockResolvedValueOnce({ twoFactorEnabled: true });
    const result = await getHookBefore()(
      { userId: "user-1" },
      { path: "/sign-in/email" },
    );
    expect(result).toBeUndefined();
  });

  it("does nothing when user has 2FA disabled", async () => {
    mockUserFindUnique.mockResolvedValueOnce({ twoFactorEnabled: false });
    const result = await getHookBefore()(
      { userId: "user-1" },
      { path: "/two-factor/verify-totp" },
    );
    expect(result).toBeUndefined();
  });

  it("does nothing when context is undefined", async () => {
    mockUserFindUnique.mockResolvedValueOnce({ twoFactorEnabled: true });
    const result = await getHookBefore()({ userId: "user-1" }, undefined);
    expect(result).toBeUndefined();
  });

  it("blocks magic-link verify for admin users", async () => {
    mockUserFindUnique.mockResolvedValueOnce({ role: "admin", twoFactorEnabled: false });
    mockMembershipFindMany.mockResolvedValueOnce([]);
    await expect(
      getHookBefore()({ userId: "user-1" }, { path: "/magic-link/verify" }),
    ).rejects.toThrow("staff accounts");
  });

  it("blocks magic-link verify for users with store memberships", async () => {
    mockUserFindUnique.mockResolvedValueOnce({ role: "customer", twoFactorEnabled: false });
    mockMembershipFindMany.mockResolvedValueOnce([{ id: "m1" }]);
    await expect(
      getHookBefore()({ userId: "user-1" }, { path: "/magic-link/verify" }),
    ).rejects.toThrow("staff accounts");
  });

  it("blocks magic-link verify for 2FA-enabled users", async () => {
    mockUserFindUnique.mockResolvedValueOnce({ role: "customer", twoFactorEnabled: true, emailVerified: true });
    mockMembershipFindMany.mockResolvedValueOnce([]);
    await expect(
      getHookBefore()({ userId: "user-1" }, { path: "/magic-link/verify" }),
    ).rejects.toThrow("staff accounts");
  });

  it("allows magic-link verify for plain customers", async () => {
    mockUserFindUnique
      .mockResolvedValueOnce({ role: "customer", twoFactorEnabled: false })
      .mockResolvedValueOnce({ twoFactorEnabled: false });
    mockMembershipFindMany.mockResolvedValueOnce([]);
    const result = await getHookBefore()(
      { userId: "user-1" },
      { path: "/magic-link/verify" },
    );
    expect(result).toBeUndefined();
  });
});

describe("validateAuthSecret", () => {
  it("throws in production when secret is missing", () => {
    expect(() =>
      validateAuthSecret({ NODE_ENV: "production" }),
    ).toThrow("BETTER_AUTH_SECRET is required");
  });

  it("throws in production when secret is too short", () => {
    expect(() =>
      validateAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "short",
      }),
    ).toThrow("at least 32 characters");
  });

  it("passes in production with a 32+ char secret", () => {
    expect(() =>
      validateAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "a".repeat(32),
      }),
    ).not.toThrow();
  });

  it("skips validation during next build phase", () => {
    expect(() =>
      validateAuthSecret({
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-build",
      }),
    ).not.toThrow();
  });

  it("skips validation in development", () => {
    expect(() =>
      validateAuthSecret({ NODE_ENV: "development" }),
    ).not.toThrow();
  });

  it("skips validation in test", () => {
    expect(() => validateAuthSecret({ NODE_ENV: "test" })).not.toThrow();
  });
});

// The CI and local e2e server is `next start` (NODE_ENV=production) with CI=true and VERCEL unset;
// a real deployment is VERCEL set, or NODE_ENV=production without CI=true.
const PROD = { NODE_ENV: "production" };
const CI_SERVER = { NODE_ENV: "production", CI: "true" };
const VERCEL_CI = { NODE_ENV: "production", VERCEL: "1", CI: "true" };

describe("AUTH_RATE_LIMIT_RELAXED only outside a deployment", () => {
  it("is ignored in production and on Vercel, even with CI=true", () => {
    expect(resolveAuthRateLimitRelaxed({ ...PROD, AUTH_RATE_LIMIT_RELAXED: "1" })).toBe(false);
    expect(resolveAuthRateLimitRelaxed({ ...VERCEL_CI, AUTH_RATE_LIMIT_RELAXED: "1" })).toBe(false);
  });

  it("still relaxes the CI e2e server and local runs", () => {
    expect(resolveAuthRateLimitRelaxed({ ...CI_SERVER, AUTH_RATE_LIMIT_RELAXED: "1" })).toBe(true);
    expect(resolveAuthRateLimitRelaxed({ NODE_ENV: "test", AUTH_RATE_LIMIT_RELAXED: "1" })).toBe(true);
    expect(resolveAuthRateLimitRelaxed({ ...CI_SERVER })).toBe(false);
  });
});

describe("localhost origins and hosts only outside a deployment", () => {
  it("production trusts no localhost or 127.0.0.1 origin or host", () => {
    for (const env of [PROD, VERCEL_CI]) {
      const hosts = resolveAuthAllowedHosts({ ...env, BETTER_AUTH_URL: "https://markets.example" });
      expect(hosts.filter((h) => h.includes("localhost") || h.includes("127.0.0.1"))).toEqual([]);
      expect(hosts).toContain("markets.example");
      const origins = resolveAuthTrustedOrigins({ ...env, BETTER_AUTH_TRUSTED_ORIGINS: "https://markets.example" });
      expect(origins.filter((o) => o.includes("localhost") || o.includes("127.0.0.1"))).toEqual([]);
      expect(origins).toContain("https://markets.example");
    }
  });

  it("the CI e2e server keeps its localhost origins and hosts", () => {
    expect(resolveAuthAllowedHosts({ ...CI_SERVER, PORT: "4710" })).toEqual(
      expect.arrayContaining(["localhost:4710", "127.0.0.1:4710"]),
    );
    expect(resolveAuthTrustedOrigins({ ...CI_SERVER, PORT: "4710" })).toContain("http://localhost:4710");
  });
});

describe("client IP for rate limits", () => {
  function ipOf(headers: Record<string, string>): string | null {
    return getIP(new Request("http://localhost:3000/api/auth/sign-in/email", { headers }), auth.options);
  }

  it("a two-hop x-forwarded-for still resolves each client to its own address", () => {
    expect(ipOf({ "x-vercel-forwarded-for": "198.51.100.7", "x-forwarded-for": "198.51.100.7, 10.1.2.3" })).toBe(
      "198.51.100.7",
    );
    expect(ipOf({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9, 10.1.2.3" })).toBe("203.0.113.9");
  });
});

describe("validateAuthSecret refuses test secrets in a deployment", () => {
  const committed = (
    readFileSync(resolve(process.cwd(), ".env.e2e"), "utf8")
      .split("\n")
      .find((line) => line.startsWith("BETTER_AUTH_SECRET=")) ?? ""
  )
    .slice("BETTER_AUTH_SECRET=".length)
    .trim();

  it("rejects the committed CI secret and any do-not-use value in production", () => {
    expect(committed.length).toBeGreaterThanOrEqual(32);
    expect(() => validateAuthSecret({ ...PROD, BETTER_AUTH_SECRET: committed })).toThrow();
    expect(() => validateAuthSecret({ ...VERCEL_CI, BETTER_AUTH_SECRET: committed })).toThrow();
    expect(() => validateAuthSecret({ ...PROD, BETTER_AUTH_SECRET: `${"k".repeat(32)}-do-not-use` })).toThrow();
  });

  it("lets the CI e2e server boot on the committed secret", () => {
    expect(() => validateAuthSecret({ ...CI_SERVER, BETTER_AUTH_SECRET: committed })).not.toThrow();
  });
});

describe("secure auth cookies", () => {
  it("are Secure in production even when BETTER_AUTH_URL is http", () => {
    expect(resolveAuthSecureCookies({ ...PROD, BETTER_AUTH_URL: "http://markets.example" })).toBe(true);
    expect(resolveAuthSecureCookies({ ...VERCEL_CI, BETTER_AUTH_URL: "http://markets.example" })).toBe(true);
  });

  it("follow the scheme on the CI e2e server and locally", () => {
    expect(resolveAuthSecureCookies({ ...CI_SERVER, BETTER_AUTH_URL: "http://localhost:4710" })).toBe(false);
    expect(resolveAuthSecureCookies({ BETTER_AUTH_URL: "https://markets.example" })).toBe(true);
    expect(resolveAuthSecureCookies({})).toBe(false);
  });
});

describe("the auth config built in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("ignores AUTH_RATE_LIMIT_RELAXED and sets Secure cookies on an http base URL", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("AUTH_RATE_LIMIT_RELAXED", "1");
    vi.stubEnv("BETTER_AUTH_URL", "http://markets.example");
    vi.stubEnv("BETTER_AUTH_SECRET", "p".repeat(40));
    vi.resetModules();
    const built = (await import("./auth")).auth.options;
    expect(built.rateLimit?.max).toBe(10);
    expect(built.rateLimit?.customRules?.["/sign-in/email"]).toEqual({ window: 60, max: 5 });
    expect(built.rateLimit?.customRules?.["/magic-link/verify"]).toEqual({ window: 60, max: 5 });
    expect(built.advanced?.useSecureCookies).toBe(true);
  });

  // The magic-link plugin caps /magic-link/verify at 5 a minute per IP on its own rule (#748).
  it("relaxes the magic-link verify limit on the CI e2e server", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("AUTH_RATE_LIMIT_RELAXED", "1");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3148");
    vi.stubEnv("BETTER_AUTH_SECRET", "p".repeat(40));
    vi.resetModules();
    const built = (await import("./auth")).auth.options;
    expect(built.rateLimit?.customRules?.["/magic-link/verify"]).toEqual({ window: 60, max: 1000 });
  });
});
