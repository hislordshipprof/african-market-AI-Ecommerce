import { listStores } from "./actions";
import { getReviewStats } from "./catalog-actions";
import { listOrdersToCheck } from "./orders-to-check";
import { listRefundFailedOrders } from "./refund-resolution";
import { listEscalatedThreads } from "../support/platform-actions";
import { listStoreApplications, PENDING_APPLICATIONS_LISTED } from "../store-application/service";

/** `incomplete` means the list behind the count was capped, so the real count is at least `count`. */
export type QueueCount = { count: number; incomplete: boolean };

/** A null count means its query failed; the home page shows that tile as not loaded. */
export type AdminHomeCounts = {
  stores: { active: number; suspended: number } | null;
  refunds: QueueCount | null;
  ordersToCheck: QueueCount | null;
  messages: QueueCount | null;
  catalogReview: QueueCount | null;
  applications: QueueCount | null;
};

/** Counts for the admin home page, read through each queue's own page query. The page checks the admin first. */
export async function getAdminHomeCounts(): Promise<AdminHomeCounts> {
  const [stores, refunds, orders, messages, review, applications] = await Promise.allSettled([
    listStores(),
    listRefundFailedOrders(),
    listOrdersToCheck(),
    listEscalatedThreads(),
    getReviewStats(),
    listStoreApplications(),
  ]);
  return {
    stores: settled(stores, (list) => {
      const active = list.filter((store) => store.status === "active").length;
      const suspended = list.filter((store) => store.status === "suspended").length;
      return { active, suspended };
    }),
    refunds: settled(refunds, (list) => ({ count: list.length, incomplete: false })),
    ordersToCheck: settled(orders, (queues) => ({
      count: queues.stuck.length + queues.alerts.length,
      incomplete: queues.cappedGroups.length > 0 || queues.alertsCapped,
    })),
    // Only threads waiting on the platform team; answered ones wait on the customer. Waiting threads are listed first,
    // so hidden threads can only add to the count when every listed one waits.
    messages: settled(messages, ({ threads, hidden }) => {
      const waiting = threads.filter((thread) => thread.waiting).length;
      return { count: waiting, incomplete: hidden > 0 && waiting === threads.length };
    }),
    catalogReview: settled(review, (stats) => ({ count: stats.needsReview, incomplete: false })),
    applications: settled(applications, ({ pending }) => ({
      count: pending.length,
      incomplete: pending.length >= PENDING_APPLICATIONS_LISTED,
    })),
  };
}

function settled<T, R>(result: PromiseSettledResult<T>, count: (value: T) => R): R | null {
  if (result.status === "fulfilled") return count(result.value);
  console.error("[admin home] count query failed", result.reason);
  return null;
}
