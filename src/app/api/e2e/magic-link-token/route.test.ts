import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, magicLinkTokenRouteAllowed } from "./route";

describe("magicLinkTokenRouteAllowed", () => {
  it("allows the e2e flag only outside Vercel and production", () => {
    expect(
      magicLinkTokenRouteAllowed({
        E2E_STORE_OVERRIDE: "1",
        NODE_ENV: "test",
      }),
    ).toBe(true);
  });

  it("allows local Playwright (next start, preview, no VERCEL)", () => {
    expect(
      magicLinkTokenRouteAllowed({
        E2E_STORE_OVERRIDE: "1",
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
      }),
    ).toBe(true);
  });

  it("refuses when VERCEL is set", () => {
    expect(
      magicLinkTokenRouteAllowed({
        E2E_STORE_OVERRIDE: "1",
        VERCEL: "1",
        NODE_ENV: "test",
      }),
    ).toBe(false);
  });

  it("refuses when NODE_ENV=production", () => {
    expect(
      magicLinkTokenRouteAllowed({
        E2E_STORE_OVERRIDE: "1",
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });

  it("refuses when VERCEL_ENV=production", () => {
    expect(
      magicLinkTokenRouteAllowed({
        E2E_STORE_OVERRIDE: "1",
        NODE_ENV: "test",
        VERCEL_ENV: "production",
      }),
    ).toBe(false);
  });

  it("refuses without the e2e flag", () => {
    expect(magicLinkTokenRouteAllowed({ NODE_ENV: "development" })).toBe(false);
  });
});

describe("GET /api/e2e/magic-link-token", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 404 when VERCEL is set", async () => {
    vi.stubEnv("E2E_STORE_OVERRIDE", "1");
    vi.stubEnv("VERCEL", "1");
    const res = await GET(
      new NextRequest("http://localhost/api/e2e/magic-link-token?email=a@b.test"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when NODE_ENV=production", async () => {
    vi.stubEnv("E2E_STORE_OVERRIDE", "1");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "");
    const res = await GET(
      new NextRequest("http://localhost/api/e2e/magic-link-token?email=a@b.test"),
    );
    expect(res.status).toBe(404);
  });
});
