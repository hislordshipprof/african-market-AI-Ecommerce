import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashTag } from "./events";

describe("hashTag", () => {
  it("is stable for one value and differs between values", () => {
    expect(hashTag("203.0.113.77")).toBe(hashTag("203.0.113.77"));
    expect(hashTag("203.0.113.77")).not.toBe(hashTag("203.0.113.78"));
    expect(hashTag("203.0.113.77")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("cannot be reversed by hashing every candidate IP without the server key", () => {
    const tag = hashTag("203.0.113.77");
    const plain = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 16);
    const recovered = Array.from({ length: 256 }, (_, i) => `203.0.113.${i}`).filter((ip) => plain(ip) === tag);
    expect(recovered).toEqual([]);
  });
});
