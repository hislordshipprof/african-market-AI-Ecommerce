import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { lockStoreRow, storeScoped, storeScopedTransaction } from "../db";
import { deliveryProofBucket, issuePhotoKey, uploadIssuePhoto } from "../r2";
import { money } from "../format";
import { prepareProofPhoto } from "./delivery-proof";
import { evaluateOrderRefundState, submitRefund } from "./refund-requests";
import { redactedErrorMessage } from "./staff-copy";

export const ISSUE_TYPES = ["missing", "damaged", "wrong", "poor_freshness"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];
export type IssueState = "auto_refunded" | "in_review" | "approved" | "declined" | "refund_failed";

/** A problem is reported within 48 h of `completedAt` (spec §5). */
export const ISSUE_WINDOW_MS = 48 * 60 * 60 * 1000;
const REPORTABLE_STATUSES = new Set(["DELIVERED", "COMPLETED"]);

export const ISSUE_ORDER_NOT_FOUND = "We couldn't find that order.";
export const ISSUE_WINDOW_CLOSED = "Problems can be reported up to 48 hours after your order is complete. Please contact the store.";
export const ISSUE_ALREADY_REPORTED = "You have already reported a problem with this order. Please contact the store.";
export const ISSUE_LINES_INVALID = "Choose the items that had a problem from this order.";
export const ISSUE_PHOTO_INVALID = "Add one photo of the problem: a JPEG, PNG or WebP image.";
export const ISSUE_STORAGE_NOT_SET_UP = "Problem reports are not set up for this store yet. Please contact the store.";

export type IssueReportInput = {
  type: IssueType;
  lines: Array<{ lineId: string; qty: number }>;
  note: string | null;
  photo: Uint8Array | null;
};

/** What the customer sees about their report on the tracking and report pages. */
export function issueStateMessage(issue: { state: string; amountCents: number }): string {
  switch (issue.state) {
    case "auto_refunded":
    case "approved":
      return `A refund of ${money(issue.amountCents)} is on its way to your card.`;
    case "declined":
      return "The store reviewed your report and did not issue a refund. Please contact the store with any questions.";
    case "refund_failed":
      return "Your refund did not go through. The store and our team have been alerted and will sort it out.";
    default:
      return "The store is reviewing your report.";
  }
}

type ReportableOrder = {
  status: string;
  completedAt: Date | null;
  paymentIntentId: string | null;
};

/** Open while a finished, charged order is inside its 48 h window. */
export function issueWindowOpen(order: ReportableOrder, now = new Date()): boolean {
  if (!REPORTABLE_STATUSES.has(order.status) || !order.completedAt || !order.paymentIntentId) return false;
  return now.getTime() - order.completedAt.getTime() <= ISSUE_WINDOW_MS;
}

type OrderWithLines = ReportableOrder & {
  lines: Array<{ id: string; qtyPicked: number; unitPriceCents: number }>;
};

/** Picked quantity × unit price for the chosen lines; fees and tip are never part of it. Null when a line is not this order's. */
function issueAmountCents(order: OrderWithLines, chosen: IssueReportInput["lines"]): number | null {
  if (chosen.length === 0) return null;
  const byId = new Map(order.lines.map((line) => [line.id, line]));
  const seen = new Set<string>();
  let total = 0;
  for (const pick of chosen) {
    const line = byId.get(pick.lineId);
    if (!line || seen.has(pick.lineId)) return null;
    if (!Number.isInteger(pick.qty) || pick.qty < 1 || pick.qty > line.qtyPicked) return null;
    seen.add(pick.lineId);
    total += pick.qty * line.unitPriceCents;
  }
  return total > 0 ? total : null;
}

function refusal(
  order: (OrderWithLines & { issueReports: unknown[] }) | null,
  input: IssueReportInput,
  now: Date,
): { error: string } | { amount: number } {
  if (!order) return { error: ISSUE_ORDER_NOT_FOUND };
  if (order.issueReports.length > 0) return { error: ISSUE_ALREADY_REPORTED };
  if (!issueWindowOpen(order, now)) return { error: ISSUE_WINDOW_CLOSED };
  const amount = issueAmountCents(order, input.lines);
  if (amount == null) return { error: ISSUE_LINES_INVALID };
  return { amount };
}

const orderForIssue = { lines: true, issueReports: { select: { id: true } } } as const;

/**
 * The customer's one report for an order, by tracking token. At or under the store's limit it is
 * refunded to the card through the refund ledger; above it, it waits for the store.
 */
export async function submitIssueReport(
  store: { id: string; autoRefundLimitCents: number },
  token: string,
  input: IssueReportInput,
  now = new Date(),
): Promise<{ ok: true; state: IssueState; amountCents: number } | { ok: false; error: string }> {
  const early = refusal(
    await storeScoped(store.id).order.findUnique({ where: { trackingToken: token }, include: orderForIssue }),
    input,
    now,
  );
  if ("error" in early) return { ok: false, error: early.error };
  if (!deliveryProofBucket()) return { ok: false, error: ISSUE_STORAGE_NOT_SET_UP };
  const prepared = await prepareProofPhoto(input.photo);
  if (!prepared.ok) return { ok: false, error: ISSUE_PHOTO_INVALID };

  const order = await storeScoped(store.id).order.findUniqueOrThrow({ where: { trackingToken: token }, select: { id: true } });
  const issueId = randomBytes(12).toString("hex");
  const photoKey = issuePhotoKey(order.id, issueId);
  await uploadIssuePhoto(photoKey, prepared.jpeg);

  let created: { ok: true; amount: number; state: IssueState; paymentIntentId: string } | { ok: false; error: string };
  try {
    created = await storeScopedTransaction(store.id, async (tx) => {
      await lockStoreRow(tx, store.id);
      const current = await tx.order.findUnique({ where: { trackingToken: token }, include: orderForIssue });
      const checked = refusal(current, input, now);
      if ("error" in checked) return { ok: false as const, error: checked.error };
      const state: IssueState = checked.amount <= store.autoRefundLimitCents ? "auto_refunded" : "in_review";
      await tx.issueReport.create({
        data: {
          id: issueId,
          storeId: store.id,
          orderId: order.id,
          type: input.type,
          lines: input.lines,
          note: input.note,
          photoKey,
          amountCents: checked.amount,
          state,
        },
      });
      return { ok: true as const, amount: checked.amount, state, paymentIntentId: current!.paymentIntentId! };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: ISSUE_ALREADY_REPORTED };
    }
    throw err;
  }
  if (!created.ok) return created;
  if (created.state === "in_review") return { ok: true, state: "in_review", amountCents: created.amount };

  try {
    const refund = await submitRefund(store.id, order.id, created.paymentIntentId, {
      cause: "issue",
      amountCents: created.amount,
      issueReportId: issueId,
    });
    if ("amountRefunded" in refund && refund.amountRefunded < created.amount) {
      await storeScoped(store.id).issueReport.update({ where: { id: issueId }, data: { amountCents: refund.amountRefunded } });
    }
  } catch (err) {
    // An open request is replayed by the ledger sweep; one Stripe refused is marked refund_failed by the evaluation below.
    console.error(`Issue refund for order ${order.id} did not finish: ${redactedErrorMessage(err)}`);
  }
  const issue = await storeScoped(store.id).issueReport.findUniqueOrThrow({ where: { id: issueId } });
  if (!issue.refundRequestId) {
    // No request was reserved (blocked, or another refund is open): the store reviews it.
    await storeScoped(store.id).issueReport.update({ where: { id: issueId }, data: { state: "in_review" } });
    return { ok: true, state: "in_review", amountCents: issue.amountCents };
  }
  await evaluateOrderRefundState(order.id);
  // Stripe can answer the create as failed; the evaluation has then marked the issue.
  const settled = await storeScoped(store.id).issueReport.findUniqueOrThrow({ where: { id: issueId }, select: { state: true, amountCents: true } });
  return { ok: true, state: settled.state as IssueState, amountCents: settled.amountCents };
}
