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
    serviceFeeCents: 0,
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
  it("out for delivery and delivered never carry cancel copy; delivered states the charged amount", () => {
    for (const [status, event] of [["OUT_FOR_DELIVERY", "out_for_delivery"], ["DELIVERED", "delivered"]] as const) {
      const email = renderEmail(order(status), event, URL, "orders@example.com");
      expect(renderSms(order(status), event, URL).text).toContain(URL);
      for (const copy of CANCEL_COPY) expect(email.html).not.toContain(copy);
    }
    expect(renderEmail(order("DELIVERED"), "delivered", URL, "orders@example.com").html).toContain("Charged $25.00.");
  });
});
