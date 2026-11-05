import { describe, expect, it } from "vitest";
import { mapRefundStatus } from "./errors";

describe("refund status", () => {
  it("maps a null refund status to pending", () => {
    expect(mapRefundStatus(null)).toBe("pending");
    expect(mapRefundStatus(undefined)).toBe("pending");
    expect(mapRefundStatus("succeeded")).toBe("succeeded");
    expect(mapRefundStatus("failed")).toBe("failed");
  });
});
