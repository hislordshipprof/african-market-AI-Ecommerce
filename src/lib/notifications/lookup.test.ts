import { describe, expect, it } from "vitest";
import { deliveryProofTokenFor } from "./lookup";

const delivered = { status: "DELIVERED", deliveredAt: new Date("2026-11-01T18:00:00Z"), deliveryProofKey: "delivery-proof/o1/1.jpg", trackingToken: "tok_secret" };

describe("deliveryProofTokenFor", () => {
  it("gives the photo token only when the page was opened with the tracking token", () => {
    expect(deliveryProofTokenFor(delivered, "tok_secret")).toBe("tok_secret");
  });

  it("keeps the photo after an issue refund moves the delivered order to Refunded", () => {
    const refunded = { ...delivered, status: "REFUNDED" };
    expect(deliveryProofTokenFor(refunded, "tok_secret")).toBe("tok_secret");
  });

  it("gives nothing when the page was opened with the order id", () => {
    expect(deliveryProofTokenFor(delivered, "order_cuid_1")).toBeNull();
  });

  it("gives nothing before delivery, without a photo, or without a token", () => {
    expect(deliveryProofTokenFor({ ...delivered, deliveredAt: null }, "tok_secret")).toBeNull();
    expect(deliveryProofTokenFor({ ...delivered, deliveryProofKey: null }, "tok_secret")).toBeNull();
    expect(deliveryProofTokenFor({ ...delivered, trackingToken: null }, "")).toBeNull();
  });
});
