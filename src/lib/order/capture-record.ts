import type { PrismaClient } from "@prisma/client";

/**
 * The one writer of an order's capture record (#537): what Stripe captured and when.
 * Set once, so a later refund, restore or cancellation never changes it. Call it inside
 * the store-scoped transaction that learned of the capture. `at` is null when the caller
 * learned of the capture after the fact and does not know when Stripe took it.
 */
export async function recordCapture(
  tx: Pick<PrismaClient, "order">,
  orderId: string,
  amountCents: number,
  at: Date | null,
): Promise<void> {
  if (amountCents <= 0) return;
  await tx.order.updateMany({ where: { id: orderId, captureCents: null }, data: { captureCents: amountCents } });
  if (at) await tx.order.updateMany({ where: { id: orderId, capturedAt: null }, data: { capturedAt: at } });
}
