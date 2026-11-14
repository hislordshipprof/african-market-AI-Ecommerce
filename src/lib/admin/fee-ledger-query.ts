import { Prisma, platformAdminTransaction } from "../db";
import { buildFeeLedger, ledgerMonth, type CaptureFacts, type FeeLedger, type RefundFacts } from "./fee-ledger";

const ORDER_FACTS = Prisma.sql`
  o.id AS "orderId", o.store_id AS "storeId", s.name AS "storeName", o.number AS "orderNumber", o.fulfillment,
  o.captured_amount_cents AS "capturedAmountCents", o.platform_fee_cents AS "platformFeeCents",
  o.service_fee_cents AS "serviceFeeCents", o.delivery_fee_cents AS "deliveryFeeCents"`;

/**
 * One UTC month of the platform fee ledger, across stores. Callers check the platform admin first.
 * Two indexed reads: captures by orders.ready_at (or cancelled_at), refunds by refund_requests.succeeded_at.
 */
export async function platformFeeLedger(monthKey: string): Promise<FeeLedger> {
  const month = ledgerMonth(monthKey);
  const lo = month.startsAt.toISOString().slice(0, 10);
  const hi = month.endsAt.toISOString().slice(0, 10);
  const [captures, refunds] = await platformAdminTransaction(async (tx) => [
    await tx.$queryRaw<CaptureFacts[]>`
        SELECT ${ORDER_FACTS}, COALESCE(o.ready_at, o.cancelled_at) AS at,
               CASE WHEN o.captured_amount_cents IS NULL THEN COALESCE((
                 SELECT SUM(r.amount_cents) FROM refund_requests r
                 WHERE r.order_id = o.id AND r.store_id = o.store_id AND r.provider_status = 'succeeded'
               ), 0) ELSE 0 END::int AS "succeededRefundsCents"
        FROM orders o
        JOIN stores s ON s.id = o.store_id
        WHERE o.status <> 'CAPTURING'
          AND ((o.ready_at >= ${lo}::timestamp AND o.ready_at < ${hi}::timestamp)
            OR (o.ready_at IS NULL AND o.cancelled_at >= ${lo}::timestamp AND o.cancelled_at < ${hi}::timestamp))`,
    // Every succeeded refund of an order with one that succeeded this month: the fee cap counts earlier ones.
    await tx.$queryRaw<RefundFacts[]>`
        SELECT ${ORDER_FACTS}, r.id AS "refundId", r.amount_cents AS "amountCents",
               r.refund_application_fee AS "refundApplicationFee", r.service_fee_share_cents AS "serviceFeeShareCents",
               r.fee_refund_id IS NOT NULL AS "feeShareReturned", r.created_at AS "createdAt", r.succeeded_at AS "succeededAt"
        FROM refund_requests r
        JOIN orders o ON o.id = r.order_id AND o.store_id = r.store_id
        JOIN stores s ON s.id = o.store_id
        WHERE r.provider_status = 'succeeded'
          AND r.order_id IN (
            SELECT d.order_id FROM refund_requests d
            WHERE d.provider_status = 'succeeded' AND d.succeeded_at >= ${lo}::timestamp AND d.succeeded_at < ${hi}::timestamp
          )`,
  ] as const);
  return buildFeeLedger(month, captures, refunds);
}
