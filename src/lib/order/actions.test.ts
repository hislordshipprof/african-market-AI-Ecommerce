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

import { STAFF_GENERIC_ERROR } from "./staff-copy";

describe("markReadyAction", () => {
  it("markReadyAction returns the generic message and logs the raw error for a provider failure", async () => {
    const { markReady } = await import("./service");
    const { markReadyAction } = await import("./actions");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    (markReady as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("PaymentIntent pi_123 has already been canceled for ada@example.com 555-123-4567"),
    );

    const result = await markReadyAction("order-1");

    expect(result).toEqual({ ok: false, error: STAFF_GENERIC_ERROR });
    expect(result.ok === false && result.error.includes("pi_")).toBe(false);
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("order_action_failed");
    expect(logged).toContain("pi_123");
    expect(logged).toContain("order-1");
    expect(logged).not.toContain("ada@example.com");
    expect(logged).not.toContain("555-123-4567");
    expect(logged).toContain("[redacted]");
    errorSpy.mockRestore();
  });

  it("markReadyAction passes an allow-listed service message through", async () => {
    const { markReady } = await import("./service");
    const { markReadyAction } = await import("./actions");
    (markReady as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "Cannot mark ready for order in status AUTHORIZED",
    });

    const result = await markReadyAction("order-1");
    expect(result).toEqual({
      ok: false,
      error: "Cannot mark ready for order in status AUTHORIZED",
    });
  });

  it("a returned provider message becomes the generic message", async () => {
    const { markReady } = await import("./service");
    const { markReadyAction } = await import("./actions");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    (markReady as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "PaymentIntent pi_456 has already been canceled",
    });

    const result = await markReadyAction("order-2");
    expect(result).toEqual({ ok: false, error: STAFF_GENERIC_ERROR });
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("pi_456");
    errorSpy.mockRestore();
  });

  it("a thrown non-Error becomes the generic message", async () => {
    const { markReady } = await import("./service");
    const { markReadyAction } = await import("./actions");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    (markReady as ReturnType<typeof vi.fn>).mockRejectedValue("network timeout");

    const result = await markReadyAction("order-1");
    expect(result).toEqual({ ok: false, error: STAFF_GENERIC_ERROR });
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("network timeout");
    errorSpy.mockRestore();
  });
});
