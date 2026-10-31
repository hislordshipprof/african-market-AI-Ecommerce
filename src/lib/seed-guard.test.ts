import { describe, it, expect } from "vitest";
import { assertNotProduction } from "./seed-guard";

describe("assertNotProduction", () => {
  it("throws when VERCEL_ENV is production", () => {
    expect(() => assertNotProduction({ VERCEL_ENV: "production" })).toThrow(
      "seeding test admin in production is not allowed",
    );
  });

  it("throws when VERCEL_ENV is production even with CI set", () => {
    expect(() =>
      assertNotProduction({ VERCEL_ENV: "production", CI: "true" }),
    ).toThrow("seeding test admin in production is not allowed");
  });

  it("throws when NODE_ENV is production without CI", () => {
    expect(() =>
      assertNotProduction({ NODE_ENV: "production" }),
    ).toThrow("seeding test admin in production is not allowed");
  });

  it("allows NODE_ENV=production when CI is set", () => {
    expect(() =>
      assertNotProduction({ NODE_ENV: "production", CI: "true" }),
    ).not.toThrow();
  });

  it("allows local development (no production flags)", () => {
    expect(() => assertNotProduction({})).not.toThrow();
  });

  it("allows preview environments", () => {
    expect(() =>
      assertNotProduction({ VERCEL_ENV: "preview" }),
    ).not.toThrow();
  });
});
