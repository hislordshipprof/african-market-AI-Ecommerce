import { describe, expect, it } from "vitest";
import { launcherVisible } from "./launcher-gate";

describe("assistant launcher gate", () => {
  it("launcher shows only with the switch on, an active store, and a browse page", () => {
    const base = { flag: true, storeStatus: "active", pathname: "/", sessionHidden: false };
    expect(launcherVisible(base)).toBe(true);
    for (const pathname of ["/search", "/categories", "/collections/stews", "/listing/egusi", "/cart", "/credits", "/missing"]) {
      expect(launcherVisible({ ...base, pathname })).toBe(true);
    }
    expect(launcherVisible({ ...base, flag: false })).toBe(false);
    expect(launcherVisible({ ...base, storeStatus: "suspended" })).toBe(false);
    expect(launcherVisible({ ...base, sessionHidden: true })).toBe(false);
    expect(launcherVisible({ ...base, pathname: "/checkout" })).toBe(false);
    expect(launcherVisible({ ...base, pathname: "/checkout/pay" })).toBe(false);
    expect(launcherVisible({ ...base, pathname: "/order/abc" })).toBe(false);
    expect(launcherVisible({ ...base, pathname: "/orders" })).toBe(true);
  });
});
