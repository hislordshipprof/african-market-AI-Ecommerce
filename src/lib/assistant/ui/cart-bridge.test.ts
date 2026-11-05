import { afterEach, describe, expect, it, vi } from "vitest";
import { bindCartRefresh, reconcileStoreCart, settleStoreCart } from "./cart-bridge";

describe("cart reconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads again after a remount and on a short delay when a turn may still be committing", () => {
    vi.useFakeTimers();
    const reads: string[] = [];
    const stop = bindCartRefresh("store-a", async () => { reads.push("first"); });
    reconcileStoreCart("store-a");
    expect(reads).toEqual(["first"]);
    stop();
    bindCartRefresh("store-a", async () => { reads.push("remount"); });
    expect(reads).toEqual(["first", "remount"]);
    vi.advanceTimersByTime(400);
    expect(reads).toEqual(["first", "remount", "remount"]);
  });

  it("stops the late reads once the turn settles", async () => {
    vi.useFakeTimers();
    bindCartRefresh("store-b", async () => {});
    reconcileStoreCart("store-b");
    await settleStoreCart("store-b");
    expect(vi.getTimerCount()).toBe(0);
  });
});
