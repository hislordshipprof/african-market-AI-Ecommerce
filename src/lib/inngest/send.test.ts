import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client", () => ({
  inngest: { send: vi.fn() },
}));

vi.mock("../db", () => ({
  storeScopedTransaction: vi.fn(),
}));

describe("sendOrderAuthorized", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("K8: logs but does not throw when DB update fails after successful send", async () => {
    const { inngest } = await import("./client");
    const { storeScopedTransaction } = await import("../db");
    const { sendOrderAuthorized } = await import("./send");

    (inngest.send as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    let callCount = 0;
    (storeScopedTransaction as ReturnType<typeof vi.fn>).mockImplementation(async (_sid: string, fn: (tx: unknown) => unknown) => {
      callCount++;
      if (callCount === 1) {
        return fn({ order: { findUnique: () => ({ createdAt: new Date() }) } });
      }
      throw new Error("DB connection lost");
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(sendOrderAuthorized("store-1", "order-1")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[inngest]"),
      expect.stringContaining("DB connection lost"),
    );

    warnSpy.mockRestore();
  });

  it("K8: logs but does not throw when inngest.send itself fails", async () => {
    const { inngest } = await import("./client");
    const { storeScopedTransaction } = await import("../db");
    const { sendOrderAuthorized } = await import("./send");

    (storeScopedTransaction as ReturnType<typeof vi.fn>).mockImplementation(async (_sid: string, fn: (tx: unknown) => unknown) => {
      return fn({ order: { findUnique: () => ({ createdAt: new Date() }) } });
    });
    (inngest.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Inngest unreachable"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(sendOrderAuthorized("store-1", "order-1")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[inngest]"),
      expect.stringContaining("Inngest unreachable"),
    );

    warnSpy.mockRestore();
  });

  it("Codex-3: includes authorizedAt from order.createdAt in event data", async () => {
    const { inngest } = await import("./client");
    const { storeScopedTransaction } = await import("../db");
    const { sendOrderAuthorized } = await import("./send");

    const createdAt = new Date("2026-11-02T10:00:00Z");
    (storeScopedTransaction as ReturnType<typeof vi.fn>).mockImplementation(async (_sid: string, fn: (tx: unknown) => unknown) => {
      return fn({
        order: { findUnique: () => ({ createdAt }), update: () => ({}) },
      });
    });
    (inngest.send as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await sendOrderAuthorized("store-1", "order-1");

    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authorizedAt: createdAt.toISOString(),
        }),
      }),
    );
  });
});
