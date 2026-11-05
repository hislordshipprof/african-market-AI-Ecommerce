import { afterEach, describe, expect, it, vi } from "vitest";

const afterMock = vi.hoisted(() => vi.fn());

vi.mock("next/server", () => ({
  after: afterMock,
}));

import { scheduleAfterResponse } from "./schedule-after-response";

describe("scheduleAfterResponse", () => {
  afterEach(() => {
    afterMock.mockReset();
  });

  it("hands the in-flight send promise to after()", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;

    scheduleAfterResponse(async () => {
      started = true;
      await gate;
    });

    expect(started).toBe(true);
    expect(afterMock).toHaveBeenCalledTimes(1);
    const pending = afterMock.mock.calls[0][0] as Promise<unknown>;
    expect(typeof pending.then).toBe("function");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await pending;
    expect(settled).toBe(true);
  });

  it("logs a rejection without an email address when after() has no request scope", async () => {
    afterMock.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    scheduleAfterResponse(async () => {
      throw new Error("smtp down for shopper@example.com");
    });

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("magic_link_delivery_failed");
    expect(logged).toContain("[redacted]");
    expect(logged).not.toContain("shopper@example.com");
    errorSpy.mockRestore();
  });

  it("logs the caller's event name on failure", async () => {
    afterMock.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    scheduleAfterResponse(async () => {
      throw new Error("send down");
    }, "inngest_send_failed");

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("inngest_send_failed");
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("magic_link_delivery_failed");
    errorSpy.mockRestore();
  });
});
