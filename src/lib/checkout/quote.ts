import { validPhone } from "../customer-account/phone";
import { money } from "../format";
import { serviceFeeCents, type ServiceFeeSettings } from "../order/platform-fee";
import { goodsDiscountCents, type CouponTerms } from "../coupon/discount";
import type { CheckoutQuote, Contact, FlowProblem, Fulfillment } from "../customer-flow/contracts";

/** The pure checkout quote. Stripe-free, so the assistant can draw a Review card from it (#247). */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export interface StoreDeliveryQuote {
  enabled: boolean;
  feeCents: number;
  radiusMi: number;
  hasCoordinates: boolean;
  /** Null until Census has confirmed the address. Distance is not stored here. */
  confirmed: { withinRadius: boolean } | null;
  leaveAtDoor: boolean;
}

/** A Starter store does not offer courier delivery (ADR-0021). */
export const COURIER_NOT_OFFERED = "This store does not offer courier delivery.";

/** The cheapest live courier quote (#140 selection), or why courier delivery is unavailable. */
export type CourierQuoteInput =
  | { ok: true; feeCents: number; provider: "Uber Direct" | "DoorDash Drive"; leaveAtDoor: boolean; changed?: boolean }
  | { ok: false; problem: FlowProblem };

/** The cart's code, with the coupon it names when the store accepts it here, or why not (#557). */
export type QuoteCouponInput =
  | { code: string; coupon: CouponTerms & { id: string; minGoodsCents: number } }
  | { code: string; refusal: string };

/** The discount on goods only; shortfalls under the code's minimum get no discount and a note, never a block. */
function couponDiscount(goodsCents: number, input: QuoteCouponInput): { discountCents: number; message?: string } {
  if ("refusal" in input) return { discountCents: 0, message: input.refusal };
  if (goodsCents < input.coupon.minGoodsCents) {
    return { discountCents: 0, message: `Add ${money(input.coupon.minGoodsCents - goodsCents)} more to use ${input.code}.` };
  }
  return { discountCents: goodsDiscountCents(goodsCents, input.coupon) };
}

/** The coupon an order records: the one the quote applied, even when it rounded to no discount. */
export function appliedCouponId(input: QuoteCouponInput | null | undefined, quote: CheckoutQuote): string | null {
  return input && "coupon" in input && quote.coupon && !quote.coupon.message ? input.coupon.id : null;
}

export function computeQuote(
  minimumOrderCents: number,
  cartLines: ReadonlyArray<{ price: number; qty: number; maxPerOrder: number | null; frozen?: boolean; perishable?: boolean }>,
  contact: Contact,
  fulfillment: Fulfillment,
  serviceFee: ServiceFeeSettings,
  delivery?: StoreDeliveryQuote | null,
  courier?: CourierQuoteInput | null,
  coupon?: QuoteCouponInput | null,
): CheckoutQuote {
  const problems: FlowProblem[] = [];
  let subtotalCents = 0;

  for (const line of cartLines) {
    if (
      !Number.isInteger(line.qty) ||
      line.qty < 1
    ) {
      problems.push({ code: "max-quantity", message: "Check item quantity." });
      continue;
    }
    if (line.maxPerOrder !== null && line.qty > line.maxPerOrder) {
      problems.push({
        code: "max-quantity",
        message: `Maximum ${line.maxPerOrder} per order for this item.`,
      });
    }
    subtotalCents += line.price * line.qty;
  }

  if (!cartLines.length || subtotalCents < minimumOrderCents) {
    problems.push({
      code: "minimum-order",
      message: `Minimum order is $${(minimumOrderCents / 100).toFixed(2)}.`,
    });
  }

  if (
    !contact.name.trim() ||
    !validEmail(contact.email) ||
    !validPhone(contact.phone)
  ) {
    problems.push({
      code: "invalid-contact",
      message: "Name, email, and a valid phone number are required.",
    });
  }

  let deliveryFeeCents = 0;
  let courierFeeCents = 0;
  let courierProvider: CheckoutQuote["courierProvider"];
  if (fulfillment === "courier") {
    if (!courier) {
      problems.push({ code: "ineligible", message: "Only pickup is available for this store." });
    } else if (!courier.ok) {
      problems.push(courier.problem);
    } else {
      // The provider's quote, no markup (ADR-0006).
      courierFeeCents = courier.feeCents;
      courierProvider = courier.provider;
      if (courier.changed) {
        problems.push({ code: "quote-changed", message: `The courier fee is now ${money(courier.feeCents)}. Check your new total, then place your order.` });
      }
      if (courier.leaveAtDoor && cartLines.some((line) => line.frozen || line.perishable)) {
        problems.push({ code: "ineligible", message: "Frozen and perishable items need a hand-to-hand delivery. Turn off Leave at door." });
      }
    }
  } else if (fulfillment === "store-delivery") {
    // The fee stays in the hold when delivery is switched off or the radius
    // shrinks, so those refusals are visible as problems rather than a new total.
    deliveryFeeCents = Math.max(0, delivery?.feeCents ?? 0);
    if (!delivery || !delivery.enabled || !delivery.hasCoordinates || delivery.radiusMi <= 0) {
      problems.push({
        code: "ineligible",
        message: "Only pickup is available for this store.",
      });
    } else if (!delivery.confirmed) {
      problems.push({
        code: "ineligible",
        message: "We couldn't find that address",
      });
    } else if (!delivery.confirmed.withinRadius) {
      problems.push({
        code: "outside-radius",
        message: "That address is outside the delivery area",
      });
    }
    if (delivery?.leaveAtDoor && cartLines.some((line) => line.frozen)) {
      problems.push({
        code: "ineligible",
        message: "Frozen items require handoff.",
      });
    }
  }

  const tipCents = 0;
  const applied = coupon ? couponDiscount(subtotalCents, coupon) : null;
  const discountCents = applied?.discountCents ?? 0;
  const goodsCents = subtotalCents - discountCents;
  const serviceFeeCentsQuoted = serviceFeeCents(goodsCents, serviceFee);
  const totalCents = goodsCents + serviceFeeCentsQuoted + tipCents + deliveryFeeCents + courierFeeCents;
  const bufferCents = Math.min(Math.round(goodsCents * 0.1), 2000);
  const holdCents = totalCents + bufferCents;

  return {
    id: crypto.randomUUID(),
    subtotalCents,
    deliveryFeeCents,
    courierFeeCents,
    ...(courierProvider ? { courierProvider } : {}),
    serviceFeeCents: serviceFeeCentsQuoted,
    taxCents: 0,
    tipCents,
    discountCents,
    ...(coupon && applied
      ? { coupon: { code: coupon.code, discountCents, ...(applied.message ? { message: applied.message } : {}) } }
      : {}),
    totalCents,
    bufferCents,
    holdCents,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    problems,
  };
}

