import { describe, expect, it } from "vitest";
import { draftDescription } from "./drafts";

const facts = {
  listingId: "l1",
  name: "Egusi 1 lb",
  currentDescription: null,
  // As listing_facts records it: the listing id is not part of the text.
  text: JSON.stringify({ name: "Egusi 1 lb", origin: "Nigeria", sizes: ["1 lb"] }),
};

const refusal = (text: string) => {
  try {
    draftDescription({ listingId: "l1", text }, facts);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

describe("description drafts use the listing's facts only (#820)", () => {
  it("accepts a factual description and keeps the current one to check at confirm", () => {
    const draft = draftDescription({ listingId: "l1", text: "Ground egusi melon seeds from Nigeria, 1 lb.  Used in egusi soup." }, facts);
    expect(draft).toEqual({
      kind: "description",
      payload: { listingId: "l1", name: "Egusi 1 lb", text: "Ground egusi melon seeds from Nigeria, 1 lb. Used in egusi soup." },
      before: { description: null },
    });
  });

  it("refuses health claims, prices, stock words and numbers the facts do not hold", () => {
    expect(refusal("Egusi seeds that boost your immunity.")).toMatch(/health/);
    expect(refusal("Egusi seeds, a healthy superfood.")).toMatch(/health/);
    expect(refusal("Egusi seeds from Nigeria, only $6.99.")).toMatch(/prices/);
    expect(refusal("Egusi seeds from Nigeria, in stock now.")).toMatch(/stock/);
    expect(refusal("Egusi seeds from Nigeria, 5 lb bag.")).toMatch(/numbers/);
  });

  it("refuses another listing's id and a too-short text", () => {
    expect(() => draftDescription({ listingId: "l2", text: "Ground egusi melon seeds from Nigeria." }, facts)).toThrow(/listing_facts/);
    expect(refusal("Egusi.")).toMatch(/20 to 600/);
  });
});
