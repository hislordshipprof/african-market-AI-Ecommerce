import { storeScoped } from "../db";
import { pushToStoreMembers } from "./store-members";

/** "Problem to review" to each member's device when a customer's report waits for the store. Never throws for a push failure. */
export async function sendIssueToReviewPush(store: { id: string; slug: string }, trackingToken: string): Promise<void> {
  const order = await storeScoped(store.id).order.findUnique({ where: { trackingToken }, select: { id: true, number: true } });
  if (!order) return;
  await pushToStoreMembers(store.id, {
    title: "Problem to review",
    body: `Order #${order.number}: the customer reported a problem`,
    url: `/store-admin/orders?store=${encodeURIComponent(store.slug)}#problems`,
    tag: `issue-${order.id}`,
  });
}
