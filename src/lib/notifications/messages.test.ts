import { describe, expect, it } from "vitest";
import { renderEmail, renderSms, type NotifyOrder } from "./messages";

const URL = "https://adas.markets.example/order/tok_abc";

function order(status: string, capturedAmountCents: number | null = 2500): NotifyOrder {
  return {
    id: "order1",
    number: 1042,
    status,
    fulfillment: "store-delivery",
    subtotalCents: 2000,
    tipCents: 0,
    deliveryFeeCents: 500,
    totalAuthorizedCents: 2750,
    capturedAmountCents,
    refundId: null,
    prepEstimateMinutes: 20,
    acceptedAt: new Date(),
    trackingToken: "tok_abc",
    customer: { name: "Ada", email: "ada@example.com", phone: "+13014482210" },
    store: {
      name: "Ada's Market",
      slug: "adas",
      logoUrl: null,
      brandColor: "#1F5A43",
      themePreset: "palm-and-shea",
      timezone: "America/Chicago",
    },
    lines: [{
      status: "picked",
      qtyOrdered: 1,
      qtyPicked: 1,
      unitPriceCents: 2000,
      listingVariant: { label: "bag", listing: { customName: "Egusi", masterProduct: null } },
      substituteVariant: null,
    }],
    manualResolution: null,
  };
}

const CANCEL_COPY = ["not charged", "refunded", "hold was released", "Cancelled"];

describe("store delivery messages", () => {
  it("out for delivery: email and SMS say Out for delivery with the exact order number and no cancel copy", () => {
    const email = renderEmail(order("OUT_FOR_DELIVERY"), "out_for_delivery", URL, "orders@example.com");
    const sms = renderSms(order("OUT_FOR_DELIVERY"), "out_for_delivery", URL);
    expect(email.subject).toBe("Ada's Market order #1042: Out for delivery");
    expect(email.html).toContain("Out for delivery. Order #1042.");
    expect(email.html).toContain(URL);
    expect(sms.text).toBe(`Ada's Market: order #1042 Out for delivery. Track it: ${URL}`);
    for (const copy of CANCEL_COPY) expect(email.html).not.toContain(copy);
  });

  it("delivered: email shows Delivered, the exact order number and the charged amount, never the cancel copy", () => {
    const email = renderEmail(order("DELIVERED"), "delivered", URL, "orders@example.com");
    const sms = renderSms(order("DELIVERED"), "delivered", URL);
    expect(email.subject).toBe("Ada's Market order #1042: Delivered");
    expect(email.html).toContain("Delivered. Order #1042.");
    expect(email.html).toContain("Charged $25.00.");
    expect(email.html).toContain("<li>1 × Egusi — $20.00</li>");
    expect(sms.text).toBe(`Ada's Market: order #1042 Delivered. Track it: ${URL}`);
    for (const copy of CANCEL_COPY) expect(email.html).not.toContain(copy);
  });
});
