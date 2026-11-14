import { validPhone } from "../customer-account/phone";
import { serviceFeeCents, type ServiceFeeSettings } from "../order/platform-fee";
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

export function computeQuote(
  minimumOrderCents: number,
  cartLines: ReadonlyArray<{ price: number; qty: number; maxPerOrder: number | null; frozen?: boolean }>,
  contact: Contact,
  fulfillment: Fulfillment,
  serviceFee: ServiceFeeSettings,
  delivery?: StoreDeliveryQuote | null,
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
  if (fulfillment === "courier") {
    problems.push({
      code: "ineligible",
      message: "Only pickup is available for this store.",
    });
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
  const serviceFeeCentsQuoted = serviceFeeCents(subtotalCents, serviceFee);
  const totalCents = subtotalCents + serviceFeeCentsQuoted + tipCents + deliveryFeeCents;
  const bufferCents = Math.min(Math.round(subtotalCents * 0.1), 2000);
  const holdCents = totalCents + bufferCents;

  return {
    id: crypto.randomUUID(),
    subtotalCents,
    deliveryFeeCents,
    courierFeeCents: 0,
    serviceFeeCents: serviceFeeCentsQuoted,
    taxCents: 0,
    tipCents,
    discountCents: 0,
    totalCents,
    bufferCents,
    holdCents,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    problems,
  };
}

