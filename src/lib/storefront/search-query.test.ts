import { describe, expect, it } from "vitest";
import { normalizedSearchQuery } from "./search-query";

describe("normalizedSearchQuery", () => {
  it("accepts 200 characters, rejects 201, and trims a long run of spaces", () => {
    expect(normalizedSearchQuery("a".repeat(200))).toEqual({
      query: "a".repeat(200),
      tooLong: false,
    });
    expect(normalizedSearchQuery("a".repeat(201))).toEqual({
      query: "a".repeat(201),
      tooLong: true,
    });
    expect(normalizedSearchQuery(" ".repeat(201))).toEqual({ query: "", tooLong: false });
  });
});
