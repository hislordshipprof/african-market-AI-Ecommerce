import { describe, expect, it } from "vitest";
import { taxLineInputs } from "./checkout-tax";

describe("taxLineInputs", () => {
  const codes = new Map([["v-a", "txcd_40040000"], ["v-z", null]]);
  const a = { variantId: "v-a", qty: 1, price: 1000 };
  const z = { variantId: "v-z", qty: 1, price: 1000 };

  it("gives the same lines, with the same share of the coupon, whatever order the basket is read in", () => {
    // $1.01 off $20.00 cannot split evenly; the odd cent must land on the same line both times.
    const expected = [
      { reference: "v-a", amountCents: 949, taxCode: "txcd_40040000" },
      { reference: "v-z", amountCents: 950, taxCode: null },
    ];
    expect(taxLineInputs([a, z], 101, codes)).toEqual(expected);
    expect(taxLineInputs([z, a], 101, codes)).toEqual(expected);
  });
});
