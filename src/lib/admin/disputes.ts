import { platformAdminTransaction } from "../db";
import { CLOSED_DISPUTE_STATUSES, stripeDisputeUrl } from "../disputes/status";
import { requirePlatformAdmin } from "./session";

/** Open disputes are few; a queue longer than this says so instead of paging. */
export const DISPUTE_QUEUE_LIMIT = 200;

/**
 * The platform's dispute queue (#539): every open dispute across stores, the soonest evidence deadline first and
 * those with no deadline last. Evidence is answered in the Stripe Dashboard.
 */
export async function listOpenDisputes() {
  await requirePlatformAdmin();
  const checkedAt = new Date();
  const found = await platformAdminTransaction((tx) =>
    tx.paymentDispute.findMany({
      where: { status: { notIn: [...CLOSED_DISPUTE_STATUSES] } },
      orderBy: [{ evidenceDueBy: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      take: DISPUTE_QUEUE_LIMIT + 1,
      select: {
        id: true,
        stripeDisputeId: true,
        amountCents: true,
        currency: true,
        reason: true,
        status: true,
        evidenceDueBy: true,
        livemode: true,
        createdAt: true,
        orderId: true,
        order: { select: { number: true } },
        store: { select: { name: true } },
      },
    }),
  );
  return {
    checkedAt,
    more: found.length > DISPUTE_QUEUE_LIMIT,
    rows: found.slice(0, DISPUTE_QUEUE_LIMIT).map(({ order, store, livemode, ...row }) => ({
      ...row,
      orderNumber: order?.number ?? null,
      storeName: store?.name ?? null,
      dashboardUrl: stripeDisputeUrl(row.stripeDisputeId, livemode),
    })),
  };
}
