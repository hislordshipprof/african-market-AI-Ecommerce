import { Prisma, platformAdminRawQuery } from "../db";
import {
  buildFeeLedger, ledgerMonth, type CaptureFacts, type FeeLedger, type LedgerMonth, type RefundFacts, type RepaymentFacts,
} from "./fee-ledger";

const ORDER_FACTS = Prisma.sql`
  o.id AS "orderId", o.store_id AS "storeId", s.name AS "storeName", o.number AS "orderNumber", o.fulfillment,
  o.confirmed_capture_cents AS "capturedAmountCents", o.platform_fee_cents AS "platformFeeCents",
  o.service_fee_cents AS "serviceFeeCents", o.delivery_fee_cents AS "deliveryFeeCents",
  o.tax_cents AS "taxCents", o.tax_liable_party AS "taxLiableParty"`;

/** UTC month bounds as timestamps, matching the UTC values Prisma stores in timestamp(3) columns. */
function bounds(month: LedgerMonth) {
  return { lo: month.startsAt.toISOString().slice(0, 10), hi: month.endsAt.toISOString().slice(0, 10) };
}

/** Orders whose capture was confirmed in the month (orders_capture_confirmed_at_idx). */
export function captureFactsSql(month: LedgerMonth): Prisma.Sql {
  const { lo, hi } = bounds(month);
  return Prisma.sql`
    SELECT ${ORDER_FACTS}, o.capture_confirmed_at AS at, o.status = 'REFUND_FAILED' AS "refundFailed"
    FROM orders o
    JOIN stores s ON s.id = o.store_id
    WHERE o.capture_confirmed_at >= ${lo}::timestamp AND o.capture_confirmed_at < ${hi}::timestamp`;
}

/**
 * Every succeeded refund of an order with one that succeeded in the month (refund_requests_succeeded_at_idx):
 * the fee cap counts the order's earlier refunds too.
 */
export function refundFactsSql(month: LedgerMonth): Prisma.Sql {
  const { lo, hi } = bounds(month);
  return Prisma.sql`
    SELECT ${ORDER_FACTS}, r.id AS "refundId", r.amount_cents AS "amountCents",
           r.refund_application_fee AS "refundApplicationFee", r.service_fee_share_cents AS "serviceFeeShareCents",
           r.platform_tax_share_cents AS "platformTaxShareCents",
           r.fee_refund_id IS NOT NULL AS "feeShareReturned", r.created_at AS "createdAt", r.succeeded_at AS "succeededAt"
    FROM refund_requests r
    JOIN orders o ON o.id = r.order_id AND o.store_id = r.store_id
    JOIN stores s ON s.id = o.store_id
    WHERE r.provider_status = 'succeeded'
      AND r.order_id IN (
        SELECT d.order_id FROM refund_requests d
        WHERE d.provider_status = 'succeeded' AND d.succeeded_at >= ${lo}::timestamp AND d.succeeded_at < ${hi}::timestamp
      )`;
}

/** Manual repayments recorded in the month (audit_logs action, created_at index). */
export function repaymentFactsSql(month: LedgerMonth): Prisma.Sql {
  const { lo, hi } = bounds(month);
  return Prisma.sql`
    SELECT ${ORDER_FACTS}, a.id AS "repaymentId", a.created_at AS at, (a.after->>'repaidCents')::int AS "repaidCents"
    FROM audit_logs a
    JOIN orders o ON o.id = a.entity_id AND o.store_id = a.store_id
    JOIN stores s ON s.id = o.store_id
    WHERE a.action = 'refund_resolved_manually' AND a.entity_type = 'order'
      AND a.created_at >= ${lo}::timestamp AND a.created_at < ${hi}::timestamp`;
}

/** One UTC month of the platform fee ledger, across stores. Callers check the platform admin first. */
export async function platformFeeLedger(monthKey: string): Promise<FeeLedger> {
  const month = ledgerMonth(monthKey);
  const [captures, refunds, repayments] = await Promise.all([
    platformAdminRawQuery<CaptureFacts>(captureFactsSql(month)),
    platformAdminRawQuery<RefundFacts>(refundFactsSql(month)),
    platformAdminRawQuery<RepaymentFacts>(repaymentFactsSql(month)),
  ]);
  return buildFeeLedger(month, captures, refunds, repayments);
}
