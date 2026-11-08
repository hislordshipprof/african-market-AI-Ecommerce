import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPrisma } from "../db";
import { addressCacheKey } from "./geo";
import { confirmDeliveryAddress, lookupConfirmed } from "./confirm";
import { fakeLocate } from "./fake";
import { setAddressProvider } from "./provider";

const hasDb = !!process.env.DATABASE_URL;
const STORE = { lat: 29.693857800118, lng: -95.266257879374, radiusMi: 8 };
const PARTS = { line1: "3700 Main St", city: "Houston", state: "TX", zip: "77002" };

describe.skipIf(!hasDb)("geocode cache", () => {
  let calls = 0;

  beforeAll(async () => {
    setAddressProvider({
      suggest: async () => [],
      locate: async (parts) => {
        calls += 1;
        return fakeLocate(parts);
      },
    });
    await authPrisma.$executeRaw`DELETE FROM address_geocodes WHERE key = ${addressCacheKey(PARTS)}`;
  });

  afterAll(() => {
    setAddressProvider(null);
  });

  it("a repeat confirm of the same address is served from the cache", async () => {
    const first = await confirmDeliveryAddress(PARTS, STORE, { limit: true, ip: "203.0.113.50" });
    expect(first.ok).toBe(true);
    expect(calls).toBe(1);
    const second = await confirmDeliveryAddress(PARTS, STORE, { limit: true, ip: "203.0.113.50" });
    expect(second.ok).toBe(true);
    expect(calls).toBe(1);
    for (let i = 0; i < 25; i += 1) {
      const looked = await lookupConfirmed(PARTS, STORE);
      expect(looked?.ok).toBe(true);
      const again = await confirmDeliveryAddress(PARTS, STORE, { limit: true, ip: "203.0.113.50" });
      expect(again.ok).toBe(true);
    }
    expect(calls).toBe(1);
  });
});
