import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { platform, platformAdminTransaction, storeScoped } from "../db";
import { lineChargeCents, type ChargeLine } from "../order/substitution-pricing";
import { getTaxCalculator, TaxUnavailableError, type LineTaxAmount, type TaxLine, type TaxLineInput, type TaxReversalPlan } from "./calculator";
import { taxAddress, variantTaxCodes } from "./checkout-tax";

/**
 * Tax at capture (#65, coordinator addendum "Amount rules"): shorts and swaps change the goods, so
 * Ready makes a new Stripe Tax calculation on the final picked lines, and after the capture records
 * that calculation as the sale's tax transaction.
 */

export type CaptureTaxOrder = {
  id: string;
  storeId: string;
  fulfillment: string;
  taxCents: number;
  taxLines: unknown;
  taxLiableParty: string;
  taxCalculationId: string | null;
  deliveryLine1: string | null;
  deliveryLine2: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryZip: string | null;
};

export type CaptureTaxLine = ChargeLine & { id: string; listingVariantId: string };

/** `lineTaxes` is by order line id (#671); a line not in it has no tax. */
export type FinalTax = { calculationId: string | null; taxCents: number; lines: TaxLine[]; lineTaxes: LineTaxAmount[] };

/**
 * The final tax on the picked lines, after each line's share of the coupon discount. An order placed
 * before tax (no calculation, no tax) is not recalculated. Throws TaxLocationError or
 * TaxUnavailableError, so a capture never goes ahead untaxed.
 */
export async function finalizeTaxForCapture(
  order: CaptureTaxOrder,
  lines: CaptureTaxLine[],
  lineDiscountsCents: number[],
): Promise<FinalTax> {
  if (order.taxCalculationId == null && order.taxCents === 0) {
    return { calculationId: null, taxCents: 0, lines: (order.taxLines ?? []) as TaxLine[], lineTaxes: [] };
  }
  const db = storeScoped(order.storeId);
  const [store, codes] = await Promise.all([
    platform.store.findUniqueOrThrow({
      where: { id: order.storeId },
      select: { addressLine1: true, addressLine2: true, city: true, state: true, zip: true, stripeAccountId: true },
    }),
    // A swapped unit sold at the substitute's price is taxed with the original line's code.
    variantTaxCodes(db, lines.map((line) => line.listingVariantId)),
  ]);
  const inputs: TaxLineInput[] = lines
    .map((line, index) => ({
      reference: line.id,
      amountCents: lineChargeCents(line) - (lineDiscountsCents[index] ?? 0),
      taxCode: codes.get(line.listingVariantId) ?? null,
    }))
    .filter((line) => line.amountCents > 0);
  if (inputs.length === 0) return { calculationId: null, taxCents: 0, lines: [], lineTaxes: [] };

  const address = taxAddress(order.fulfillment === "pickup" ? "pickup" : "store-delivery", store, order);
  const liableParty = order.taxLiableParty === "store" ? "store" : "platform";
  const key = JSON.stringify({ address, liableParty, lines: inputs });
  const calculation = await getTaxCalculator().calculate({
    address,
    lines: inputs,
    liableParty,
    stripeAccount: store.stripeAccountId,
    idempotencyKey: `tax-capture:${order.id}:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
  });
  if (calculation.lines.length > 0 && calculation.lines.reduce((sum, line) => sum + line.amount, 0) !== calculation.taxCents) {
    throw new TaxUnavailableError(new Error("Tax lines do not sum to the tax total"));
  }
  if (calculation.lineTaxes.reduce((sum, line) => sum + line.taxCents, 0) !== calculation.taxCents) {
    throw new TaxUnavailableError(new Error("Line taxes do not sum to the tax total"));
  }
  return { calculationId: calculation.id, taxCents: calculation.taxCents, lines: calculation.lines, lineTaxes: calculation.lineTaxes };
}

/** Statuses where a capture stands and its sale is reported; cancelled and in-flight orders are not. */
const NOT_RECORDABLE = ["CAPTURING", "CANCELLING", "CANCELLED"];

/**
 * Records a captured order's final calculation as its tax transaction (reference `order_<id>`, so a
 * retry is idempotent). A failure leaves taxTransactionId null, pending for the sweep; the capture is
 * never undone for it (E10). Returns whether the order now has a transaction.
 */
export async function recordTaxTransaction(storeId: string, orderId: string): Promise<boolean> {
  const db = storeScoped(storeId);
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { status: true, captureCents: true, taxCalculationId: true, taxTransactionId: true, taxLiableParty: true },
  });
  if (!order?.taxCalculationId || order.captureCents == null || NOT_RECORDABLE.includes(order.status)) return false;
  if (order.taxTransactionId) return true;
  const liableParty = order.taxLiableParty === "store" ? "store" : "platform";
  try {
    const store = await platform.store.findUniqueOrThrow({ where: { id: storeId }, select: { stripeAccountId: true } });
    const transaction = await getTaxCalculator().recordTransaction({
      calculationId: order.taxCalculationId,
      reference: `order_${orderId}`,
      liableParty,
      stripeAccount: store.stripeAccountId,
    });
    await db.order.updateMany({ where: { id: orderId, taxTransactionId: null }, data: { taxTransactionId: transaction.id } });
    return true;
  } catch (error) {
    console.error(`Tax transaction pending for order ${orderId}:`, error);
    return false;
  }
}

/** Retries captured orders whose tax transaction is still pending (E10, E11). Returns how many were recorded. */
export async function recordPendingTaxTransactions(limit: number, opts?: { storeIds?: readonly string[] }): Promise<number> {
  if (opts?.storeIds && opts.storeIds.length === 0) return 0;
  const pending = await platformAdminTransaction((tx) => tx.order.findMany({
    where: {
      taxCalculationId: { not: null },
      taxTransactionId: null,
      captureCents: { not: null },
      status: { notIn: NOT_RECORDABLE },
      ...(opts?.storeIds ? { storeId: { in: [...opts.storeIds] } } : {}),
    } satisfies Prisma.OrderWhereInput,
    select: { id: true, storeId: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  }));
  let recorded = 0;
  for (const row of pending) {
    if (await recordTaxTransaction(row.storeId, row.id)) recorded += 1;
  }
  return recorded;
}

/**
 * Reverses the order's tax transaction for each succeeded refund that owes a reversal (#671), once per refund: the
 * reference `refund_<request id>` is also the idempotency key. A failure leaves it pending for the sweep; so does a
 * refund before the transaction is recorded. Returns how many were reversed.
 */
export async function reverseRefundTax(storeId: string, orderId: string): Promise<number> {
  const db = storeScoped(storeId);
  const order = await db.order.findUnique({ where: { id: orderId }, select: { taxTransactionId: true, taxLiableParty: true } });
  if (!order?.taxTransactionId) return 0;
  const due = await db.refundRequest.findMany({
    where: { orderId, providerStatus: "succeeded", taxReversalId: null, taxReversal: { not: Prisma.DbNull } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (due.length === 0) return 0;
  const store = await platform.store.findUniqueOrThrow({ where: { id: storeId }, select: { stripeAccountId: true } });
  let reversed = 0;
  for (const row of due) {
    try {
      const reversal = await getTaxCalculator().reverseTransaction({
        transactionId: order.taxTransactionId,
        reference: `refund_${row.id}`,
        liableParty: order.taxLiableParty === "store" ? "store" : "platform",
        stripeAccount: store.stripeAccountId,
        plan: row.taxReversal as TaxReversalPlan,
      });
      await db.refundRequest.updateMany({ where: { id: row.id, taxReversalId: null }, data: { taxReversalId: reversal.id } });
      reversed += 1;
    } catch (error) {
      console.error(`Tax reversal pending for refund ${row.id} of order ${orderId}:`, error);
    }
  }
  return reversed;
}

/** Retries succeeded refunds whose tax reversal is still pending, on orders whose transaction is recorded. */
export async function reversePendingTaxRefunds(limit: number, opts?: { storeIds?: readonly string[] }): Promise<number> {
  if (opts?.storeIds && opts.storeIds.length === 0) return 0;
  const pending = await platformAdminTransaction((tx) => tx.refundRequest.findMany({
    where: {
      providerStatus: "succeeded",
      taxReversalId: null,
      taxReversal: { not: Prisma.DbNull },
      order: { taxTransactionId: { not: null } },
      ...(opts?.storeIds ? { storeId: { in: [...opts.storeIds] } } : {}),
    } satisfies Prisma.RefundRequestWhereInput,
    select: { orderId: true, storeId: true },
    distinct: ["orderId"],
    orderBy: { orderId: "asc" },
    take: limit,
  }));
  let reversed = 0;
  for (const row of pending) reversed += await reverseRefundTax(row.storeId, row.orderId);
  return reversed;
}
