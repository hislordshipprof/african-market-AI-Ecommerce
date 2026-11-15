/**
 * Stripe dispute statuses after which nothing more is decided (a late win can still move lost to won). Open means
 * not closed, so an unknown new Stripe status stays in the queue.
 */
export const CLOSED_DISPUTE_STATUSES: readonly string[] = ["won", "lost", "warning_closed", "prevented"];

export function isClosedDisputeStatus(status: string): boolean {
  return CLOSED_DISPUTE_STATUSES.includes(status);
}

const STATUS_LABELS: Record<string, string> = {
  warning_needs_response: "Inquiry, needs response",
  warning_under_review: "Inquiry, under review",
  warning_closed: "Inquiry closed",
  needs_response: "Needs response",
  under_review: "Under review",
  appeal_needs_response: "Appeal, needs response",
  appeal_under_review: "Appeal, under review",
  won: "Won",
  lost: "Lost",
  prevented: "Prevented",
};

const REASON_LABELS: Record<string, string> = {
  bank_cannot_process: "Bank cannot process",
  check_returned: "Check returned",
  credit_not_processed: "Refund not processed",
  customer_initiated: "Customer initiated",
  debit_not_authorized: "Debit not authorized",
  duplicate: "Duplicate charge",
  fraudulent: "Fraudulent",
  general: "General",
  incorrect_account_details: "Incorrect account details",
  insufficient_funds: "Insufficient funds",
  noncompliant: "Noncompliant",
  product_not_received: "Order not received",
  product_unacceptable: "Order unacceptable",
  subscription_canceled: "Subscription cancelled",
  unrecognized: "Charge not recognized",
};

function humanize(value: string): string {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function disputeStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? humanize(status);
}

export function disputeReasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? humanize(reason);
}

/** Evidence is submitted in the Stripe Dashboard, not in the app. */
export function stripeDisputeUrl(stripeDisputeId: string, livemode: boolean): string {
  return `https://dashboard.stripe.com/${livemode ? "" : "test/"}disputes/${encodeURIComponent(stripeDisputeId)}`;
}
