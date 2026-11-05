import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { showCapturedLine } from "./staff-copy";

describe("captured line", () => {
  it("no CAPTURE_FAILED label or copy remains", () => {
    const inbox = readFileSync("src/app/store-admin/orders/order-inbox.tsx", "utf8");
    const service = readFileSync("src/lib/order/service.ts", "utf8");
    expect(inbox).not.toContain("CAPTURE_FAILED");
    expect(service).not.toContain("CAPTURE_FAILED");
    expect(inbox).toContain("REFUND_FAILED_STAFF_COPY");
  });

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
