import { describe, it, expect, vi } from "vitest";

vi.mock("./db", () => ({
  authPrisma: {
    user: { findUnique: vi.fn() },
    session: { deleteMany: vi.fn() },
  },
}));

import {
  auth,
  resolveAuthBaseUrl,
  resolveAuthTrustedOrigins,
  validateAuthSecret,
} from "./auth";
import { authPrisma } from "./db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFindUnique = authPrisma.user.findUnique as any;

describe("auth config", () => {
  it("has session cookie cache disabled globally", () => {
    const opts = auth.options as Record<string, unknown>;
    const session = opts.session as Record<string, unknown>;
    const cookieCache = session.cookieCache as Record<string, unknown>;
    expect(cookieCache.enabled).toBe(false);
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

  it("sets twoFactorVerified=true for /two-factor/ path", async () => {
    mockFindUnique.mockResolvedValueOnce({ twoFactorEnabled: true });
    const result = await getHookBefore()(
      { userId: "user-1" },
      { path: "/two-factor/verify-totp" },
    );
    expect(result).toEqual({ data: { twoFactorVerified: true } });
  });

  it("does NOT set twoFactorVerified for /sign-in/magic-link path", async () => {
    mockFindUnique.mockResolvedValueOnce({ twoFactorEnabled: true });
    const result = await getHookBefore()(
      { userId: "user-1" },
      { path: "/sign-in/magic-link" },
    );
    expect(result).toBeUndefined();
  });

  it("does NOT set twoFactorVerified for /phone-number/verify path", async () => {
    mockFindUnique.mockResolvedValueOnce({ twoFactorEnabled: true });
    const result = await getHookBefore()(
      { userId: "user-1" },
      { path: "/phone-number/verify" },
    );
    expect(result).toBeUndefined();
  });

  it("does NOT set twoFactorVerified for /sign-in/email path", async () => {
    mockFindUnique.mockResolvedValueOnce({ twoFactorEnabled: true });
    const result = await getHookBefore()(
      { userId: "user-1" },
      { path: "/sign-in/email" },
    );
    expect(result).toBeUndefined();
  });

  it("does nothing when user has 2FA disabled", async () => {
    mockFindUnique.mockResolvedValueOnce({ twoFactorEnabled: false });
    const result = await getHookBefore()(
      { userId: "user-1" },
      { path: "/two-factor/verify-totp" },
    );
    expect(result).toBeUndefined();
  });

  it("does nothing when context is undefined", async () => {
    mockFindUnique.mockResolvedValueOnce({ twoFactorEnabled: true });
    const result = await getHookBefore()({ userId: "user-1" }, undefined);
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
