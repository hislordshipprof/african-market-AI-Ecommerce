import { describe, expect, it } from "vitest";
import { quotedFrom } from "../email/from";
import { renderEmail, renderSms, renderWhatsApp, smsStoreName, type NotifyOrder } from "./messages";

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

describe("renderWhatsApp (#560)", () => {
  const sender = { phoneNumberId: "1234567890", accessToken: "token" };
  const name = (rendered: ReturnType<typeof renderWhatsApp>) => (rendered?.whatsapp?.message as { name: string }).name;

  it("uses one template per event, with the store name and the tracking path only", () => {
    const placed = renderWhatsApp(order("AUTHORIZED"), "placed", URL, "+13014482210", sender)!;
    expect(placed.whatsapp!.sender).toBe(sender);
    expect(placed.whatsapp!.message).toEqual({
      type: "template",
      to: "+13014482210",
      name: "order_placed",
      language: "en_US",
      components: [
        { type: "body", parameters: [{ type: "text", text: "Ada's Market" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "order/tok_abc" }] },
      ],
    });
    expect(JSON.stringify(placed)).not.toContain("order1");
    expect(JSON.stringify(placed)).not.toContain("1042");

    const events = ["accepted", "out_for_delivery", "delivered", "completed", "cancelled", "refunded"] as const;
    expect(events.map((event) => name(renderWhatsApp(order("ACCEPTED"), event, URL, "+1", sender)))).toEqual([
      "order_accepted", "order_out_for_delivery", "order_delivered", "order_completed", "order_cancelled", "order_refund_issued",
    ]);
    expect(name(renderWhatsApp(order("READY"), "ready", URL, "+1", sender))).toBe("order_ready_delivery");
    expect(name(renderWhatsApp({ ...order("AWAITING_PICKUP"), fulfillment: "pickup" }, "ready", URL, "+1", sender))).toBe("order_ready_pickup");
    const prompt = renderWhatsApp(order("SUBSTITUTION_PENDING"), "substitution", `${URL}/substitutions`, "+1", sender)!;
    expect(name(prompt)).toBe("order_substitution_prompt");
    expect(JSON.stringify(prompt)).toContain('"order/tok_abc/substitutions"');
  });

  it("keeps the query of a link served with ?store=, and refuses a link with no path", () => {
    const local = renderWhatsApp(order("AUTHORIZED"), "placed", "http://localhost:3000/order/tok_abc?store=adas", "+1", sender)!;
    expect(JSON.stringify(local)).toContain('"order/tok_abc?store=adas"');
    expect(renderWhatsApp(order("AUTHORIZED"), "placed", "https://adas.markets.example", "+1", sender)).toBeNull();
  });
});
