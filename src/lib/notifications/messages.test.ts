import { describe, expect, it } from "vitest";
import { quotedFrom } from "../email/from";
import { renderEmail, renderSms, smsStoreName, type NotifyOrder } from "./messages";

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
    discountCents: 0,
    coupon: null,
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

  it("#495: the charged email shows the service fee inside the charged amount", () => {
    const html = renderEmail({ ...order("DELIVERED", 2560), serviceFeeCents: 60 }, "delivered", URL, "orders@example.com").html;
    expect(html).toContain("<p>Service fee $0.60.</p><p>Charged $25.60.</p>");
    expect(renderEmail(order("DELIVERED"), "delivered", URL, "orders@example.com").html).not.toContain("Service fee");
  });
});

describe("#557: promo discount on receipts", () => {
  // Goods $20.00 − SAVE10 $2.00 + delivery $5.00 + service fee $0.54 (3% of $18.00) = $23.54.
  const promo = { ...order("DELIVERED", 2354), serviceFeeCents: 54, discountCents: 200, coupon: { code: "SAVE10" } };

  it("the charged email shows the promo line before the service fee and charged amount", () => {
    const html = renderEmail(promo, "delivered", URL, "orders@example.com").html;
    expect(html).toContain("<p>Promo SAVE10: −$2.00.</p><p>Service fee $0.54.</p><p>Charged $23.54.</p>");
  });

  it("an order with no discount, or a coupon code that needs escaping, stays safe", () => {
    expect(renderEmail(order("DELIVERED"), "delivered", URL, "orders@example.com").html).not.toContain("Promo");
    const html = renderEmail({ ...promo, coupon: { code: "<b>X" } }, "delivered", URL, "orders@example.com").html;
    expect(html).toContain("Promo &lt;b&gt;X: −$2.00.");
  });
});

describe("store name in headers and SMS", () => {
  it("a tab or newline between words becomes one space, not a joined word", () => {
    expect(smsStoreName('"Best"\tMarket')).toBe('"Best" Market');
    expect(quotedFrom("Best\nMarket", "orders@example.com")).toBe('"Best Market" <orders@example.com>');
  });
});
