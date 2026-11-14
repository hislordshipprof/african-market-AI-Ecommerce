import { storeScoped } from "../db";
import { ACCOUNT_ORDER_LIMIT, type AccountOrderRecord } from "./order-history-view";

/**
 * This store's orders on the account Customer plus those on guest rows it claimed,
 * newest first, at most 50. One query; line counts come from `_count`.
 */
export async function listAccountOrders(
  storeId: string,
  accountCustomerId: string,
): Promise<AccountOrderRecord[]> {
  const rows = await storeScoped(storeId).order.findMany({
    where: {
      storeId,
      OR: [
        { customerId: accountCustomerId },
        { customer: { storeId, claimedByCustomerId: accountCustomerId } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { number: "desc" }],
    take: ACCOUNT_ORDER_LIMIT,
    select: {
      id: true,
      number: true,
      status: true,
      createdAt: true,
      subtotalCents: true,
      tipCents: true,
      deliveryFeeCents: true,
      serviceFeeCents: true,
      capturedAmountCents: true,
      refundId: true,
      trackingToken: true,
      _count: { select: { lines: true } },
    },
  });
  return rows.map(({ _count, ...row }) => ({ ...row, itemCount: _count.lines }));
}
