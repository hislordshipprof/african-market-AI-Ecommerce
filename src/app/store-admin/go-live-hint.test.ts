import { describe, expect, it } from "vitest";
import { directoryNote, testOrderHint } from "./go-live-hint";

describe("testOrderHint (#784)", () => {
  it("names the store's minimum order, so the test order can be placed", () => {
    const hint = testOrderHint(3500);
    expect(hint).toContain("$35.00");
    expect(hint).not.toMatch(/small order/);
  });

  it("follows the store's own minimum", () => {
    expect(testOrderHint(5000)).toContain("$50.00");
  });

  it("with no minimum, asks for any order", () => {
    const hint = testOrderHint(0);
    expect(hint).not.toContain("$");
    expect(hint).toMatch(/order/);
  });
});

describe("directoryNote (#786)", () => {
  it("a store with a map point is told it is listed", () => {
    expect(directoryNote(true)).toBe("Your store is listed in the Store directory.");
  });

  it("a store whose address has no map point is never told it is listed; the directory hides it until then", () => {
    const note = directoryNote(false);
    expect(note).not.toMatch(/is listed/);
    expect(note).toBe("Your store appears in the Store directory once the platform team confirms its address.");
  });
});
