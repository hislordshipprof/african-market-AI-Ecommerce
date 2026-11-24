import { describe, expect, it } from "vitest";
import { storeDeliveryOffered } from "./store-delivery-offered";

const ready = { storeDeliveryEnabled: true, deliveryRadiusMi: 8, lat: 38.99, lng: -77.03 };
const withBucket = { R2_PROOF_BUCKET: "proofs" };

describe("storeDeliveryOffered", () => {
  it("is offered when switched on, with a radius, a pickup point and the proof bucket", () => {
    expect(storeDeliveryOffered(ready, withBucket)).toBe(true);
    // Prisma hands the radius over as a Decimal.
    expect(storeDeliveryOffered({ ...ready, deliveryRadiusMi: { toString: () => "2.5" } }, withBucket)).toBe(true);
  });

  it("is not offered while the delivered photo has nowhere to be kept", () => {
    expect(storeDeliveryOffered(ready, {})).toBe(false);
    expect(storeDeliveryOffered(ready, { R2_PROOF_BUCKET: "  " })).toBe(false);
  });

  it("is not offered when switched off, with no radius, or with no point to measure from", () => {
    expect(storeDeliveryOffered({ ...ready, storeDeliveryEnabled: false }, withBucket)).toBe(false);
    expect(storeDeliveryOffered({ ...ready, deliveryRadiusMi: 0 }, withBucket)).toBe(false);
    expect(storeDeliveryOffered({ ...ready, deliveryRadiusMi: null }, withBucket)).toBe(false);
    expect(storeDeliveryOffered({ ...ready, lat: null }, withBucket)).toBe(false);
    expect(storeDeliveryOffered({ ...ready, lng: null }, withBucket)).toBe(false);
  });
});
