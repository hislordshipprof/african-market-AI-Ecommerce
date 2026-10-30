import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveDirectUrl, runtimeDatabaseUrl } from "./env";

describe("resolveDirectUrl", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL_UNPOOLED;
    saved.DIRECT_URL = process.env.DIRECT_URL;
  });

  afterEach(() => {
    if (saved.DATABASE_URL_UNPOOLED === undefined)
      delete process.env.DATABASE_URL_UNPOOLED;
    else process.env.DATABASE_URL_UNPOOLED = saved.DATABASE_URL_UNPOOLED;

    if (saved.DIRECT_URL === undefined) delete process.env.DIRECT_URL;
    else process.env.DIRECT_URL = saved.DIRECT_URL;
  });

  it("returns DATABASE_URL_UNPOOLED when set", () => {
    process.env.DATABASE_URL_UNPOOLED = "postgres://unpooled";
    process.env.DIRECT_URL = "postgres://direct";
    expect(resolveDirectUrl()).toBe("postgres://unpooled");
  });

  it("falls back to DIRECT_URL when UNPOOLED is missing", () => {
    delete process.env.DATABASE_URL_UNPOOLED;
    process.env.DIRECT_URL = "postgres://direct";
    expect(resolveDirectUrl()).toBe("postgres://direct");
  });

  it("falls back to DIRECT_URL when UNPOOLED is empty string", () => {
    process.env.DATABASE_URL_UNPOOLED = "";
    process.env.DIRECT_URL = "postgres://direct";
    expect(resolveDirectUrl()).toBe("postgres://direct");
  });

  it("throws when both are missing", () => {
    delete process.env.DATABASE_URL_UNPOOLED;
    delete process.env.DIRECT_URL;
    expect(() => resolveDirectUrl()).toThrow(
      /neither DATABASE_URL_UNPOOLED nor DIRECT_URL/i,
    );
  });

  it("throws when both are empty strings", () => {
    process.env.DATABASE_URL_UNPOOLED = "";
    process.env.DIRECT_URL = "";
    expect(() => resolveDirectUrl()).toThrow(
      /neither DATABASE_URL_UNPOOLED nor DIRECT_URL/i,
    );
  });
});

describe("runtimeDatabaseUrl", () => {
  const BASE = "postgresql://owner:secret@ep-cool-123.us-east-2.aws.neon.tech:5432/mydb?sslmode=require";

  it("replaces username and password when APP_RUNTIME_PASSWORD is set", () => {
    const result = runtimeDatabaseUrl({
      DATABASE_URL: BASE,
      APP_RUNTIME_PASSWORD: "rt_pass",
    });
    const url = new URL(result);
    expect(url.username).toBe("app_runtime");
    expect(url.password).toBe("rt_pass");
    expect(url.hostname).toBe("ep-cool-123.us-east-2.aws.neon.tech");
    expect(url.pathname).toBe("/mydb");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("preserves all URL components except credentials", () => {
    const result = runtimeDatabaseUrl({
      DATABASE_URL: "postgresql://u:p@host:6543/db?sslmode=require&options=endpoint%3Dep-abc",
      APP_RUNTIME_PASSWORD: "pw",
    });
    const url = new URL(result);
    expect(url.port).toBe("6543");
    expect(url.searchParams.get("options")).toBe("endpoint=ep-abc");
  });

  it("handles password with special characters", () => {
    const result = runtimeDatabaseUrl({
      DATABASE_URL: BASE,
      APP_RUNTIME_PASSWORD: "p@ss:w0rd/special",
    });
    const url = new URL(result);
    expect(url.username).toBe("app_runtime");
    expect(url.password).toBe("p%40ss%3Aw0rd%2Fspecial");
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => runtimeDatabaseUrl({})).toThrow(/DATABASE_URL is required/);
  });

  it("throws when DATABASE_URL is empty", () => {
    expect(() => runtimeDatabaseUrl({ DATABASE_URL: "" })).toThrow(
      /DATABASE_URL is required/,
    );
  });

  it("falls back to DATABASE_URL in dev when APP_RUNTIME_PASSWORD is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = runtimeDatabaseUrl({ DATABASE_URL: BASE });
    expect(result).toBe(BASE);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("throws in production when APP_RUNTIME_PASSWORD is missing", () => {
    expect(() =>
      runtimeDatabaseUrl({ DATABASE_URL: BASE, VERCEL_ENV: "production" }),
    ).toThrow(/APP_RUNTIME_PASSWORD is required/);
  });

  it("throws in preview when APP_RUNTIME_PASSWORD is missing", () => {
    expect(() =>
      runtimeDatabaseUrl({ DATABASE_URL: BASE, VERCEL_ENV: "preview" }),
    ).toThrow(/APP_RUNTIME_PASSWORD is required/);
  });

  it("falls back during build phase even in preview", () => {
    const result = runtimeDatabaseUrl({
      DATABASE_URL: BASE,
      VERCEL_ENV: "preview",
      NEXT_PHASE: "phase-production-build",
    });
    expect(result).toBe(BASE);
  });

  it("falls back in VERCEL_ENV=development without password", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = runtimeDatabaseUrl({
      DATABASE_URL: BASE,
      VERCEL_ENV: "development",
    });
    expect(result).toBe(BASE);
    warn.mockRestore();
  });
});
