import { describe, it, expect } from "vitest";
import { allowStoreOverride } from "./proxy";

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

  it("returns true for E2E_STORE_OVERRIDE=1", () => {
    expect(allowStoreOverride({ NODE_ENV: "production", E2E_STORE_OVERRIDE: "1" })).toBe(true);
  });

  it("returns false when both are unset", () => {
    expect(allowStoreOverride({})).toBe(false);
  });
});
