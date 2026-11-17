import { describe, expect, it, vi } from "vitest";
import { settleWithTimeout } from "./settle";

// The checkout quote effect used `.then()` with no `.catch()` and no timeout, so a
// rejected or never-settling quote left the UI stuck "estimating". This primitive is
// the fix: it must ALWAYS settle (#708 AC2b).
describe("settleWithTimeout always settles (#708 AC2b)", () => {
  it("resolves with the value when the work resolves", async () => {
    await expect(settleWithTimeout(() => Promise.resolve(7), 1000)).resolves.toEqual({
      ok: true,
      value: 7,
    });
  });

  it("settles to a failure when the work rejects", async () => {
    await expect(
      settleWithTimeout(() => Promise.reject(new Error("boom")), 1000),
    ).resolves.toEqual({ ok: false, reason: "rejected" });
  });

  it("settles to a timeout failure when the work never settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = settleWithTimeout(() => new Promise<never>(() => {}), 500);
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late rejection once it has timed out", async () => {
    vi.useFakeTimers();
    try {
      let reject!: (reason: unknown) => void;
      const pending = settleWithTimeout(() => new Promise<never>((_, r) => (reject = r)), 200);
      await vi.advanceTimersByTimeAsync(200);
      reject(new Error("too late"));
      await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
