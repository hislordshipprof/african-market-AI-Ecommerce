import type { FlowErrorCode, FlowProblem } from "@/lib/customer-flow/contracts";
import { validPhone } from "@/lib/customer-account/phone";

/**
 * Where a checkout failure is shown, so the message sits beside the control it
 * concerns (#708, #717 AC3): payment by the card, basket by the lines, session
 * and network by Pay, address by the address fields.
 */
export type IssueSection = "payment" | "basket" | "session" | "address" | "network" | "general";

export interface CheckoutIssue {
  section: IssueSection;
  message: string;
  /** Basket lines to highlight (cartItemKey values). */
  lineKeys: string[];
}

const SECTION_BY_CODE: Partial<Record<FlowErrorCode, IssueSection>> = {
  "payment-failed": "payment",
  "out-of-stock": "basket",
  "max-quantity": "basket",
  "minimum-order": "basket",
  "outside-radius": "address",
  ineligible: "address",
  "session-expired": "session",
  "quote-changed": "session",
};

/** Most pressing first: a basket problem must be fixed before anything else matters. */
const ORDER: IssueSection[] = ["basket", "address", "session", "payment"];

const BASKET_CODES = new Set<FlowErrorCode>(["out-of-stock", "max-quantity", "minimum-order"]);

/** The problems that make Pay pointless until the basket changes. Contact and address are fixed in the form. */
export function basketBlockingProblems(problems: readonly FlowProblem[]): FlowProblem[] {
  return problems.filter((problem) => BASKET_CODES.has(problem.code));
}

export function issueFromProblems(problems: readonly FlowProblem[]): CheckoutIssue | null {
  for (const section of ORDER) {
    const matching = problems.filter((problem) => SECTION_BY_CODE[problem.code] === section);
    if (!matching.length) continue;
    return {
      section,
      message: [...new Set(matching.map((problem) => problem.message))].join(" "),
      lineKeys: [...new Set(matching.flatMap((problem) => (problem.lineKey ? [problem.lineKey] : [])))],
    };
  }
  return null;
}

/** A thrown step failure: placed by the code the step attached, never by its wording. */
export function issueFromError(error: unknown, fallback = "We could not place your order. Your basket is saved."): CheckoutIssue {
  const message = error instanceof Error && error.message ? error.message : fallback;
  const code = (error as { code?: unknown } | null)?.code;
  const section = typeof code === "string" ? SECTION_BY_CODE[code as FlowErrorCode] : undefined;
  return { section: section ?? "general", message, lineKeys: [] };
}

export interface CheckoutContact {
  name: string;
  phone: string;
  email: string;
}

export type ContactField = keyof CheckoutContact;

/** The same rules the server applies, so a field is flagged before a round trip. */
export function contactErrors(contact: CheckoutContact): Partial<Record<ContactField, string>> {
  const errors: Partial<Record<ContactField, string>> = {};
  if (!contact.name.trim()) errors.name = "Enter the name for your order.";
  if (!validPhone(contact.phone)) {
    errors.phone = "Enter a valid phone number with at least 10 digits.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())) errors.email = "Enter a valid email address.";
  return errors;
}

export function firstInvalidContactField(contact: CheckoutContact): ContactField | null {
  const errors = contactErrors(contact);
  return (["name", "phone", "email"] as const).find((field) => errors[field]) ?? null;
}
