import { describe, it, expect, vi } from "vitest";

vi.mock("../store-admin/session", () => ({
  requireStoreMember: vi.fn().mockResolvedValue({
    store: { id: "store-1" },
    member: { id: "member-1" },
  }),
}));

vi.mock("./service", () => ({
  getStoreOrders: vi.fn(),
  acceptOrder: vi.fn(),
  markLinePicked: vi.fn(),
  markReady: vi.fn(),
  completePickup: vi.fn(),
}));

vi.mock("../db", () => ({
  platform: { store: { findUnique: vi.fn() } },
}));

describe("markReadyAction", () => {
  it("K8: returns ok:false with safe message when Stripe provider throws", async () => {
    const { markReady } = await import("./service");
    const { markReadyAction } = await import("./actions");

    (markReady as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("PaymentIntent pi_xxx has already been canceled and cannot be captured."),
    );

    const result = await markReadyAction("order-1");

    expect(result).toEqual({
      ok: false,
      error: "PaymentIntent pi_xxx has already been canceled and cannot be captured.",
    });
  });

  it("K8: returns ok:false with fallback message for non-Error throws", async () => {
    const { markReady } = await import("./service");
    const { markReadyAction } = await import("./actions");

    (markReady as ReturnType<typeof vi.fn>).mockRejectedValue("network timeout");

    const result = await markReadyAction("order-1");

    expect(result).toEqual({
      ok: false,
      error: "Stripe capture failed",
    });
  });
});
