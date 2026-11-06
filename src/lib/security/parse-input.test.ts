import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseInput } from "./parse-input";

describe("parseInput", () => {
  it("strict rejects unknown keys, loose strips, oversize fails, money is never coerced", () => {
    const strict = z.strictObject({ note: z.string().max(10) });
    expect(parseInput(strict, { note: "ok", extra: true }).ok).toBe(false);

    const stripping = z.object({ note: z.string() });
    expect(parseInput(stripping, { note: "ok", extra: true })).toEqual({
      ok: true,
      data: { note: "ok" },
    });

    expect(parseInput(z.object({ note: z.string().max(3) }), { note: "abcd" }).ok).toBe(false);

    const cents = z.number().int();
    expect(parseInput(cents, "10").ok).toBe(false);
    expect(parseInput(cents, 10.5).ok).toBe(false);
    expect(parseInput(cents, 1050)).toEqual({ ok: true, data: 1050 });
  });
});
