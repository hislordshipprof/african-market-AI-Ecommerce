import { describe, expect, it } from "vitest";
import {
  backupSwap,
  decideAddQty,
  decideLineQty,
  decideNamedSubstitute,
  effectiveMaxPerOrder,
  isCartSwapRule,
  substituteIdForSwap,
  UNSET_MAX_PER_ORDER,
} from "./limits";

const here = { id: "sub-1", storeId: "store-a", active: true };

describe("cart limit decisions", () => {
  it("treats a missing max as 99 and refuses 100", () => {
    expect(UNSET_MAX_PER_ORDER).toBe(99);
    expect(effectiveMaxPerOrder(null)).toBe(99);
    expect(effectiveMaxPerOrder(undefined)).toBe(99);
    expect(decideLineQty(100, null)).toEqual({
      ok: false,
      code: "max_per_order",
      maxPerOrder: 99,
    });
    expect(decideLineQty(100, undefined)).toEqual({
      ok: false,
      code: "max_per_order",
      maxPerOrder: 99,
    });
  });

  it("allows a quantity equal to the effective max", () => {
    expect(decideLineQty(99, null)).toEqual({ ok: true });
    expect(decideLineQty(5, 5)).toEqual({ ok: true });
  });

  it("uses a stored max as written, including a max above 99 or of zero", () => {
    expect(effectiveMaxPerOrder(150)).toBe(150);
    expect(effectiveMaxPerOrder(0)).toBe(0);
    expect(decideLineQty(150, 150)).toEqual({ ok: true });
    expect(decideLineQty(151, 150)).toEqual({
      ok: false,
      code: "max_per_order",
      maxPerOrder: 150,
    });
    expect(decideLineQty(6, 5)).toEqual({
      ok: false,
      code: "max_per_order",
      maxPerOrder: 5,
    });
    expect(decideLineQty(1, 0)).toEqual({
      ok: false,
      code: "max_per_order",
      maxPerOrder: 0,
    });
  });

  it("adds under the max without reporting a clamp", () => {
    expect(decideAddQty({
      existingQty: 3,
      addQty: 2,
      maxPerOrder: 5,
      clampToMax: false,
    })).toEqual({ ok: true, nextQty: 5, added: 2 });
    expect(decideAddQty({
      existingQty: 0,
      addQty: 1,
      maxPerOrder: null,
      clampToMax: false,
    })).toEqual({ ok: true, nextQty: 1, added: 1 });
  });

  it("refuses an add past the max when clamping is off", () => {
    expect(decideAddQty({
      existingQty: 4,
      addQty: 3,
      maxPerOrder: 5,
      clampToMax: false,
    })).toEqual({ ok: false, code: "max_per_order", maxPerOrder: 5 });
    expect(decideAddQty({
      existingQty: 98,
      addQty: 2,
      maxPerOrder: null,
      clampToMax: false,
    })).toEqual({ ok: false, code: "max_per_order", maxPerOrder: 99 });
  });

  it("clamps an add to the remaining room and refuses when none is left", () => {
    expect(decideAddQty({
      existingQty: 4,
      addQty: 3,
      maxPerOrder: 5,
      clampToMax: true,
    })).toEqual({ ok: true, nextQty: 5, added: 1, limitedTo: 5 });
    expect(decideAddQty({
      existingQty: 98,
      addQty: 3,
      maxPerOrder: null,
      clampToMax: true,
    })).toEqual({ ok: true, nextQty: 99, added: 1, limitedTo: 99 });
    expect(decideAddQty({
      existingQty: 5,
      addQty: 1,
      maxPerOrder: 5,
      clampToMax: true,
    })).toEqual({ ok: false, code: "max_per_order", maxPerOrder: 5 });
    expect(decideAddQty({
      existingQty: 99,
      addQty: 1,
      maxPerOrder: null,
      clampToMax: true,
    })).toEqual({ ok: false, code: "max_per_order", maxPerOrder: 99 });
  });

  it("accepts a named substitute from this store", () => {
    expect(decideNamedSubstitute(here, "store-a")).toEqual({
      ok: true,
      substituteVariantId: "sub-1",
    });
    expect(decideNamedSubstitute({ ...here, active: false }, "store-a")).toEqual({
      ok: true,
      substituteVariantId: "sub-1",
    });
  });

  it("refuses a missing substitute or one from another store", () => {
    expect(decideNamedSubstitute(null, "store-a")).toEqual({ ok: false, reason: "missing" });
    expect(decideNamedSubstitute(undefined, "store-a")).toEqual({ ok: false, reason: "missing" });
    expect(decideNamedSubstitute({ ...here, storeId: "store-b" }, "store-a")).toEqual({
      ok: false,
      reason: "other_store",
    });
  });

  it("refuses an inactive substitute only when the caller requires an active listing", () => {
    expect(decideNamedSubstitute(
      { ...here, active: false },
      "store-a",
      { requireActive: true },
    )).toEqual({ ok: false, reason: "inactive" });
    expect(decideNamedSubstitute(here, "store-a", { requireActive: true })).toEqual({
      ok: true,
      substituteVariantId: "sub-1",
    });
  });

  it("keeps a substitute id only for named_substitute", () => {
    expect(isCartSwapRule("exact_only")).toBe(true);
    expect(isCartSwapRule("store_suggests")).toBe(true);
    expect(isCartSwapRule("named_substitute")).toBe(true);
    expect(isCartSwapRule("free_for_all")).toBe(false);
    expect(substituteIdForSwap("named_substitute", "sub-1")).toBe("sub-1");
    expect(substituteIdForSwap("exact_only", "sub-1")).toBeNull();
    expect(substituteIdForSwap("store_suggests", "sub-1")).toBeNull();
  });

  it("picks a named backup only when that variant is an active listing in this store", () => {
    expect(backupSwap("line-v", "store-a", null)).toEqual({
      swapRule: "store_suggests",
      substituteVariantId: null,
    });
    expect(backupSwap("line-v", "store-a", { ...here, id: "line-v" })).toEqual({
      swapRule: "store_suggests",
      substituteVariantId: null,
    });
    expect(backupSwap("line-v", "store-a", { ...here, storeId: "store-b" })).toEqual({
      swapRule: "store_suggests",
      substituteVariantId: null,
    });
    expect(backupSwap("line-v", "store-a", { ...here, active: false })).toEqual({
      swapRule: "store_suggests",
      substituteVariantId: null,
    });
    expect(backupSwap("line-v", "store-a", here)).toEqual({
      swapRule: "named_substitute",
      substituteVariantId: "sub-1",
    });
  });
});
