import { describe, it, expect } from "vitest";
import { normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("lowercases mixed-case emails", () => {
    expect(normalizeEmail("Admin@Example.COM")).toBe("admin@example.com");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeEmail("  admin@example.com  ")).toBe("admin@example.com");
  });

  it("returns already-normalized emails unchanged", () => {
    expect(normalizeEmail("admin@example.com")).toBe("admin@example.com");
  });

  it("handles mixed whitespace and casing", () => {
    expect(normalizeEmail(" Admin@Platform.Test ")).toBe("admin@platform.test");
  });
});
