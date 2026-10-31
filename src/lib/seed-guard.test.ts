import { describe, it, expect } from "vitest";
import { assertNotProduction } from "./seed-guard";

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
