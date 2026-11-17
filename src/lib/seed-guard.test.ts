import { describe, it, expect } from "vitest";
import { assertNotProduction, assertTestAdminSeedTarget } from "./seed-guard";

describe("assertNotProduction", () => {
  it("throws when VERCEL_ENV is production", () => {
    expect(() => assertNotProduction({ VERCEL_ENV: "production" })).toThrow(
      "seeding test admin in production is not allowed",
    );
  });

  it("throws when NODE_ENV is production", () => {
    expect(() =>
      assertNotProduction({ NODE_ENV: "production" }),
    ).toThrow("seeding test admin in production is not allowed");
  });

  it("throws when both VERCEL_ENV and NODE_ENV are production", () => {
    expect(() =>
      assertNotProduction({
        VERCEL_ENV: "production",
        NODE_ENV: "production",
      }),
    ).toThrow("seeding test admin in production is not allowed");
  });

  it("allows local development (no production flags)", () => {
    expect(() => assertNotProduction({})).not.toThrow();
  });

  it("allows preview environments", () => {
    expect(() =>
      assertNotProduction({ VERCEL_ENV: "preview" }),
    ).not.toThrow();
  });

  it("allows test environments", () => {
    expect(() =>
      assertNotProduction({ NODE_ENV: "test" }),
    ).not.toThrow();
  });
});

describe("assertTestAdminSeedTarget", () => {
  const local = { observedHost: "127.0.0.1", urlHost: "localhost" };

  it("allows a loopback database", () => {
    for (const observedHost of ["127.0.0.1", "::1", "localhost", "127.0.0.1/32"]) {
      expect(() => assertTestAdminSeedTarget({ SEED_TEST_ADMIN: "1" }, { ...local, observedHost })).not.toThrow();
    }
  });

  it("refuses a remote or private database host", () => {
    for (const observedHost of ["10.0.0.5", "ep-cool-123.us-east-2.aws.neon.tech", "52.1.2.3"]) {
      expect(() => assertTestAdminSeedTarget({ SEED_TEST_ADMIN: "1" }, { ...local, observedHost })).toThrow(
        /database host/,
      );
    }
  });

  it("refuses a preview deployment even on a loopback database", () => {
    expect(() =>
      assertTestAdminSeedTarget({ SEED_TEST_ADMIN: "1", VERCEL_ENV: "preview" }, local),
    ).toThrow(/preview/);
  });

  it("allows the GitHub Actions Postgres service reached through localhost", () => {
    const service = { observedHost: "172.18.0.2", urlHost: "localhost" };
    expect(() => assertTestAdminSeedTarget({ SEED_TEST_ADMIN: "1", GITHUB_ACTIONS: "true" }, service)).not.toThrow();
    expect(() => assertTestAdminSeedTarget({ SEED_TEST_ADMIN: "1" }, service)).toThrow(/database host/);
    expect(() =>
      assertTestAdminSeedTarget({ SEED_TEST_ADMIN: "1", GITHUB_ACTIONS: "true" }, { ...service, urlHost: "db.example.com" }),
    ).toThrow(/database host/);
  });
});
