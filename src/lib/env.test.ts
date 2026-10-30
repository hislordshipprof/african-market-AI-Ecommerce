import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveDirectUrl } from "./env";

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
