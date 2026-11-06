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

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendOrderAuthorized("store-1", "order-1")).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("inngest_sent_at_update_failed"),
    );
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("DB connection lost");
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("inngest_send_failed");

    errorSpy.mockRestore();
  });

  it("K8: logs but does not throw when inngest.send itself fails", async () => {
    const { inngest } = await import("./client");
    const { storeScopedTransaction } = await import("../db");
    const { sendOrderAuthorized } = await import("./send");

    (storeScopedTransaction as ReturnType<typeof vi.fn>).mockImplementation(async (_sid: string, fn: (tx: unknown) => unknown) => {
      return fn({ order: { findUnique: () => ({ createdAt: new Date() }) } });
    });
    (inngest.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Inngest unreachable"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendOrderAuthorized("store-1", "order-1")).resolves.toBeUndefined();
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("inngest_send_failed");
    expect(logged).toContain("order-1");
    expect(logged).toContain("Inngest unreachable");
    expect(logged).not.toContain("@");

    errorSpy.mockRestore();
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
        id: "order-authorized-order-1",
        data: expect.objectContaining({
          authorizedAt: createdAt.toISOString(),
        }),
      }),
    );
  });

  it("the order/authorized event id is order-authorized-orderId", async () => {
    const { inngest } = await import("./client");
    const { storeScopedTransaction } = await import("../db");
    const { sendOrderAuthorized } = await import("./send");

    (storeScopedTransaction as ReturnType<typeof vi.fn>).mockImplementation(async (_sid: string, fn: (tx: unknown) => unknown) => {
      return fn({
        order: { findUnique: () => ({ createdAt: new Date() }), update: () => ({}) },
      });
    });
    (inngest.send as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await sendOrderAuthorized("store-1", "ord_42");

    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: "order-authorized-ord_42", name: "order/authorized" }),
    );
  });

  it("an assistant order's authorized event starts when its cancel window closes", async () => {
    const { inngest } = await import("./client");
    const { storeScopedTransaction } = await import("../db");
    const { sendOrderAuthorized } = await import("./send");
    const deadline = new Date("2026-11-06T18:10:00.000Z");

    (storeScopedTransaction as ReturnType<typeof vi.fn>).mockImplementation(async (_sid: string, fn: (tx: unknown) => unknown) => {
      return fn({
        order: {
          findUnique: () => ({ createdAt: new Date("2026-11-06T18:00:00.000Z"), cancellableUntil: deadline }),
          update: () => ({}),
        },
      });
    });
    (inngest.send as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await sendOrderAuthorized("store-1", "ord_window");

    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
      id: "order-authorized-ord_window",
      ts: deadline.getTime(),
      data: expect.objectContaining({ authorizedAt: deadline.toISOString() }),
    }));
    const payload = (inngest.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { ts: unknown };
    expect(typeof payload.ts).toBe("number");
  });

  it("a missing event key in production logs once and does not throw", async () => {
    const previousNode = process.env.NODE_ENV;
    const previousKey = process.env.INNGEST_EVENT_KEY;
    const previousDev = process.env.INNGEST_DEV;
    const previousCi = process.env.CI;
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.INNGEST_EVENT_KEY;
    delete process.env.INNGEST_DEV;

    process.env.CI = "true";
    const { inngest } = await import("./client");
    const { storeScopedTransaction } = await import("../db");
    const { sendOrderAuthorized } = await import("./send");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendOrderAuthorized("store-1", "order-1")).resolves.toBeUndefined();
    await expect(sendOrderAuthorized("store-1", "order-2")).resolves.toBeUndefined();

    const missing = errorSpy.mock.calls.filter((call) => call[0] === JSON.stringify({ event: "inngest_event_key_missing" }));
    expect(missing).toHaveLength(1);
    expect(inngest.send).not.toHaveBeenCalled();
    expect(storeScopedTransaction).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    vi.stubEnv("NODE_ENV", previousNode ?? "test");
    if (previousKey === undefined) delete process.env.INNGEST_EVENT_KEY;
    else process.env.INNGEST_EVENT_KEY = previousKey;
    if (previousDev === undefined) delete process.env.INNGEST_DEV;
    else process.env.INNGEST_DEV = previousDev;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  });

  it("a missing event key with VERCEL=1 logs once and does not send", async () => {
    const previousNode = process.env.NODE_ENV;
    const previousVercel = process.env.VERCEL;
    const previousKey = process.env.INNGEST_EVENT_KEY;
    const previousDev = process.env.INNGEST_DEV;
    vi.stubEnv("NODE_ENV", "test");
    process.env.VERCEL = "1";
    delete process.env.INNGEST_EVENT_KEY;
    delete process.env.INNGEST_DEV;

    const { inngest } = await import("./client");
    const { storeScopedTransaction } = await import("../db");
    const { sendOrderAuthorized } = await import("./send");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendOrderAuthorized("store-1", "order-1")).resolves.toBeUndefined();
    await expect(sendOrderAuthorized("store-1", "order-2")).resolves.toBeUndefined();
    expect(inngest.send).not.toHaveBeenCalled();
    expect(storeScopedTransaction).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.filter((call) => call[0] === JSON.stringify({ event: "inngest_event_key_missing" }))).toHaveLength(1);

    errorSpy.mockRestore();
    vi.stubEnv("NODE_ENV", previousNode ?? "test");
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    if (previousKey === undefined) delete process.env.INNGEST_EVENT_KEY;
    else process.env.INNGEST_EVENT_KEY = previousKey;
    if (previousDev === undefined) delete process.env.INNGEST_DEV;
    else process.env.INNGEST_DEV = previousDev;
  });

  it("Vercel ignores INNGEST_DEV when the event key is missing", async () => {
    const previousNode = process.env.NODE_ENV;
    const previousVercel = process.env.VERCEL;
    const previousKey = process.env.INNGEST_EVENT_KEY;
    const previousDev = process.env.INNGEST_DEV;
    try {
      for (const nodeEnv of ["production", "test"]) {
        vi.resetModules();
        vi.stubEnv("NODE_ENV", nodeEnv);
        process.env.VERCEL = "1";
        process.env.INNGEST_DEV = "1";
        delete process.env.INNGEST_EVENT_KEY;

        const { inngest } = await import("./client");
        const { storeScopedTransaction } = await import("../db");
        const { sendOrderAuthorized } = await import("./send");
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        await expect(sendOrderAuthorized("store-1", "order-1")).resolves.toBeUndefined();
        await expect(sendOrderAuthorized("store-1", "order-2")).resolves.toBeUndefined();

        const missing = errorSpy.mock.calls.filter((call) => call[0] === JSON.stringify({ event: "inngest_event_key_missing" }));
        expect(missing, nodeEnv).toHaveLength(1);
        expect(inngest.send, nodeEnv).not.toHaveBeenCalled();
        expect(storeScopedTransaction, nodeEnv).not.toHaveBeenCalled();
        errorSpy.mockRestore();
      }
    } finally {
      vi.stubEnv("NODE_ENV", previousNode ?? "test");
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
      if (previousKey === undefined) delete process.env.INNGEST_EVENT_KEY;
      else process.env.INNGEST_EVENT_KEY = previousKey;
      if (previousDev === undefined) delete process.env.INNGEST_DEV;
      else process.env.INNGEST_DEV = previousDev;
    }
  });

  it("a configured event key in production sends", async () => {
    const previousNode = process.env.NODE_ENV;
    const previousKey = process.env.INNGEST_EVENT_KEY;
    const previousDev = process.env.INNGEST_DEV;
    const previousVercel = process.env.VERCEL;
    vi.stubEnv("NODE_ENV", "production");
    process.env.INNGEST_EVENT_KEY = "evt_test_dummy";
    delete process.env.INNGEST_DEV;
    delete process.env.VERCEL;

    const createdAt = new Date("2026-11-02T10:00:00.000Z");
    const { inngest } = await import("./client");
    const { storeScopedTransaction } = await import("../db");
    const { sendOrderAuthorized } = await import("./send");
    (storeScopedTransaction as ReturnType<typeof vi.fn>).mockImplementation(async (_sid: string, fn: (tx: unknown) => unknown) => {
      return fn({
        order: { findUnique: () => ({ createdAt }), update: () => ({}) },
      });
    });
    (inngest.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ids: ["order-authorized-order-keyed"] });

    await sendOrderAuthorized("store-1", "order-keyed");
    expect(inngest.send).toHaveBeenCalledWith({
      id: "order-authorized-order-keyed",
      name: "order/authorized",
      data: { storeId: "store-1", orderId: "order-keyed", authorizedAt: "2026-11-02T10:00:00.000Z" },
    });

    vi.stubEnv("NODE_ENV", previousNode ?? "test");
    if (previousKey === undefined) delete process.env.INNGEST_EVENT_KEY;
    else process.env.INNGEST_EVENT_KEY = previousKey;
    if (previousDev === undefined) delete process.env.INNGEST_DEV;
    else process.env.INNGEST_DEV = previousDev;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  });

  it("INNGEST_DEV=1 sends without an event key", async () => {
    const previousNode = process.env.NODE_ENV;
    const previousKey = process.env.INNGEST_EVENT_KEY;
    const previousDev = process.env.INNGEST_DEV;
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.INNGEST_EVENT_KEY;
    process.env.INNGEST_DEV = "1";

    const { inngest } = await import("./client");
    const { storeScopedTransaction } = await import("../db");
    const { sendOrderAuthorized } = await import("./send");
    (storeScopedTransaction as ReturnType<typeof vi.fn>).mockImplementation(async (_sid: string, fn: (tx: unknown) => unknown) => {
      return fn({
        order: { findUnique: () => ({ createdAt: new Date() }), update: () => ({}) },
      });
    });
    (inngest.send as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendOrderAuthorized("store-1", "order-dev");
    expect(inngest.send).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("inngest_event_key_missing");

    errorSpy.mockRestore();
    vi.stubEnv("NODE_ENV", previousNode ?? "test");
    if (previousKey === undefined) delete process.env.INNGEST_EVENT_KEY;
    else process.env.INNGEST_EVENT_KEY = previousKey;
    if (previousDev === undefined) delete process.env.INNGEST_DEV;
    else process.env.INNGEST_DEV = previousDev;
  });

  it("a hung send gives up after 10 seconds and logs inngest_send_failed", async () => {
    const { inngest } = await import("./client");
    const { storeScopedTransaction } = await import("../db");
    const { sendOrderAuthorized } = await import("./send");
    (storeScopedTransaction as ReturnType<typeof vi.fn>).mockImplementation(async (_sid: string, fn: (tx: unknown) => unknown) => {
      return fn({ order: { findUnique: () => ({ createdAt: new Date() }) } });
    });
    (inngest.send as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => undefined));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const started = Date.now();
    await expect(sendOrderAuthorized("store-1", "order-hang")).resolves.toBeUndefined();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(elapsed).toBeLessThan(15_000);
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("inngest_send_failed");
    expect(logged).toContain("inngest send timed out");
    expect(logged).toContain("order-hang");
    errorSpy.mockRestore();
  }, 20_000);
});
