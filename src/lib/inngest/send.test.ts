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
    (storeScopedTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB connection lost"));

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
    const { sendOrderAuthorized } = await import("./send");

    (inngest.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Inngest unreachable"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(sendOrderAuthorized("store-1", "order-1")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[inngest]"),
      expect.stringContaining("Inngest unreachable"),
    );

    warnSpy.mockRestore();
  });
});
