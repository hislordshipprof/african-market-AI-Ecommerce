import { describe, expect, it } from "vitest";
import { quantityScore } from "./score";
import type { CartSnapshotLine, EvalCase } from "./types";

const rice = { listingKey: "rice", variantKeys: ["rice-5lb", "rice-10lb"] };
const evalCase: EvalCase = {
  id: "add-three",
  category: "multi-item",
  turns: ["Add rice, egusi and maggi."],
  mustHave: [
    { options: [rice] },
    { options: [{ listingKey: "egusi-whole", variantKeys: ["egusi-whole-pack"] }, { listingKey: "egusi-ground", variantKeys: ["egusi-ground-pack"] }] },
    { options: [{ listingKey: "maggi", variantKeys: ["maggi-pack"] }] },
  ],
  mayHave: [],
  gaps: [],
  qty: [
    { listingKey: "rice", variantKey: "rice-5lb", min: 1, max: 1 },
    { listingKey: "rice", variantKey: "rice-10lb", min: 1, max: 1 },
    { listingKey: "egusi-whole", variantKey: "egusi-whole-pack", min: 1, max: 1 },
    { listingKey: "egusi-ground", variantKey: "egusi-ground-pack", min: 1, max: 1 },
    { listingKey: "maggi", variantKey: "maggi-pack", min: 1, max: 1 },
  ],
};

function line(key: string, variantKey: string, qty: number): CartSnapshotLine {
  return { key, variantKey, qty, swapRule: "exact_only", substituteVariantKey: null };
}

describe("quantity accuracy", () => {
  it("counts one check per requirement, so a cart with one acceptable pack is a full hit", () => {
    const cart = [line("rice", "rice-10lb", 1), line("egusi-ground", "egusi-ground-pack", 1), line("maggi", "maggi-pack", 1)];
    expect(quantityScore(evalCase, cart)).toEqual({ checks: 3, hits: 3 });
  });

  it("misses a requirement whose chosen pack has the wrong quantity", () => {
    const cart = [line("rice", "rice-5lb", 2), line("egusi-whole", "egusi-whole-pack", 1)];
    expect(quantityScore(evalCase, cart)).toEqual({ checks: 3, hits: 1 });
  });

  it("counts a rule outside every requirement on its own", () => {
    const extra: EvalCase = { ...evalCase, qty: [...evalCase.qty!, { listingKey: "salt", variantKey: "salt-pack", min: 2, max: 2 }] };
    expect(quantityScore(extra, [line("salt", "salt-pack", 2)])).toEqual({ checks: 4, hits: 1 });
  });

  it("has no checks when the case sets no quantities", () => {
    expect(quantityScore({ ...evalCase, qty: undefined }, [])).toEqual({ checks: 0, hits: 0 });
  });
});
