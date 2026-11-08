import { storeScoped } from "../db";

const orderInclude = {
  customer: true,
  lines: {
    include: {
      listingVariant: { include: { listing: true } },
    },
  },
} as const;

/** Tracking token first, then the order id, so checkout and account links keep working. */
export async function findOrderForTracking(storeId: string, token: string) {
  const scoped = storeScoped(storeId);
  const byToken = await scoped.order.findUnique({
    where: { trackingToken: token },
    include: orderInclude,
  });
  if (byToken) return byToken;
  return scoped.order.findUnique({
    where: { id: token },
    include: orderInclude,
  });
}
