import { describe, expect, it } from "vitest";
import { showCapturedLine } from "./staff-copy";

describe("captured line", () => {
  it("shows Captured only after the money is captured", () => {
    expect(showCapturedLine("CAPTURING", 1200)).toBe(false);
    expect(showCapturedLine("PICKING", 1200)).toBe(false);
    expect(showCapturedLine("CANCELLING", 1200)).toBe(false);
    expect(showCapturedLine("CANCELLED", 1200)).toBe(false);
    expect(showCapturedLine("READY", 1200)).toBe(true);
    expect(showCapturedLine("AWAITING_PICKUP", 1200)).toBe(true);
    expect(showCapturedLine("COMPLETED", 1200)).toBe(true);
    expect(showCapturedLine("REFUND_FAILED", 1200)).toBe(true);
    expect(showCapturedLine("REFUND_FAILED", 0)).toBe(false);
  });
});
