import { validPhone } from "../customer-account/phone";
import type { CheckoutQuote, Contact, FlowProblem, Fulfillment } from "../customer-flow/contracts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/** Pickup quote. No Stripe import: the assistant model path calls this directly. */
export function computeQuote(
  minimumOrderCents: number,
  cartLines: ReadonlyArray<{ price: number; qty: number; maxPerOrder: number | null }>,
  contact: Contact,
  fulfillment: Fulfillment,
): CheckoutQuote {
  const problems: FlowProblem[] = [];
  let subtotalCents = 0;

  for (const line of cartLines) {
    if (!Number.isInteger(line.qty) || line.qty < 1) {
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

  if (!contact.name.trim() || !validEmail(contact.email) || !validPhone(contact.phone)) {
    problems.push({
      code: "invalid-contact",
      message: "Name, email, and a valid phone number are required.",
    });
  }

  if (fulfillment !== "pickup") {
    problems.push({
      code: "ineligible",
      message: "Only pickup is available for this store.",
    });
  }

  const tipCents = 0;
  const totalCents = subtotalCents + tipCents;
  const bufferCents = Math.min(Math.round(subtotalCents * 0.1), 2000);
  const holdCents = totalCents + bufferCents;

  return {
    id: crypto.randomUUID(),
    subtotalCents,
    deliveryFeeCents: 0,
    courierFeeCents: 0,
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
