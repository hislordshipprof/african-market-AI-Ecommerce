import { describe, it, expect, vi, beforeEach } from "vitest";

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
    mockUserFindUnique.mockResolvedValueOnce({ role: "customer", twoFactorEnabled: true });
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
