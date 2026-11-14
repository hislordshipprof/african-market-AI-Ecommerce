import { listStores } from "./actions";
import { getReviewStats } from "./catalog-actions";
import { listOrdersToCheck } from "./orders-to-check";
import { listRefundFailedOrders } from "./refund-resolution";
import { listEscalatedThreads } from "../support/platform-actions";

export type AdminHomeCounts = {
  stores: { active: number; suspended: number };
  refunds: number;
  ordersToCheck: { count: number; incomplete: boolean };
  messages: number;
  catalogReview: number;
};

/** Counts for the admin home page, read through each queue's own page query. Every query checks the admin. */
export async function getAdminHomeCounts(): Promise<AdminHomeCounts> {
  const [stores, refunds, orders, messages, review] = await Promise.all([
    listStores(),
    listRefundFailedOrders(),
    listOrdersToCheck(),
    listEscalatedThreads(),
    getReviewStats(),
  ]);
  const active = stores.filter((store) => store.status === "active").length;
  return {
    stores: { active, suspended: stores.length - active },
    refunds: refunds.length,
    ordersToCheck: {
      count: orders.stuck.length + orders.alerts.length,
      incomplete: orders.cappedGroups.length > 0 || orders.alertsCapped,
    },
    messages: messages.threads.length + messages.hidden,
    catalogReview: review.needsReview,
  };
}
