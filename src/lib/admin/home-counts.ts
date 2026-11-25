import { cache } from "react";
import { platformAdminTransaction } from "../db";
import { requestsByArea } from "../directory/store-requests";
import { listStores } from "./actions";
import { getReviewStats } from "./catalog-actions";
import { listOrdersToCheck } from "./orders-to-check";
import { listRefundFailedOrders } from "./refund-resolution";
import { listEscalatedThreads } from "../support/platform-actions";
import { listStoreApplications, PENDING_APPLICATIONS_LISTED } from "../store-application/service";
import { findCourierIncidents } from "./courier-incidents-query";
import { readOpenDisputes } from "./disputes";

/** Courier incidents read for the open count, as the admin briefing reads them (#834). */
const INCIDENTS_READ = 200;

/** `incomplete` means the list behind the count was capped, so the real count is at least `count`. */
export type QueueCount = { count: number; incomplete: boolean };

/** A null count means its query failed; the home page and the menu badge show it as not loaded. */
export type AdminHomeCounts = {
  stores: { total: number; active: number; setup: number; suspended: number } | null;
  refunds: QueueCount | null;
  ordersToCheck: QueueCount | null;
  messages: QueueCount | null;
  catalogReview: QueueCount | null;
  applications: QueueCount | null;
  storeRequests: QueueCount | null;
  courierIncidents: QueueCount | null;
  disputes: QueueCount | null;
};

/**
 * Counts for the admin home page and the menu badges, read through each queue's own page query. The caller checks the
 * admin first. Cached per request, so the shell and Home share one read.
 */
export const getAdminHomeCounts = cache(async (): Promise<AdminHomeCounts> => {
  const [stores, refunds, orders, messages, review, applications, requests, incidents, disputes] = await Promise.allSettled([
    listStores(),
    listRefundFailedOrders(),
    listOrdersToCheck(),
    listEscalatedThreads(),
    getReviewStats(),
    listStoreApplications(),
    requestsByArea(),
    platformAdminTransaction((tx) => findCourierIncidents(tx, {}, INCIDENTS_READ)),
    readOpenDisputes(),
  ]);
  return {
    stores: settled(stores, (list) => ({
      total: list.length,
      active: list.filter((store) => store.status === "active").length,
      setup: list.filter((store) => store.status === "setup").length,
      suspended: list.filter((store) => store.status === "suspended").length,
    })),
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
    // Shoppers waiting for a store near them, as the briefing counts them.
    storeRequests: settled(requests, (areas) => ({
      count: areas.flatMap((area) => area.zips).reduce((sum, zip) => sum + zip.waiting, 0),
      incomplete: false,
    })),
    courierIncidents: settled(incidents, ({ rows, nextCursor }) => ({
      count: rows.filter((row) => row.state === "open").length,
      incomplete: nextCursor !== null,
    })),
    disputes: settled(disputes, ({ rows, more }) => ({ count: rows.length, incomplete: more })),
  };
});

function settled<T, R>(result: PromiseSettledResult<T>, count: (value: T) => R): R | null {
  if (result.status === "fulfilled") return count(result.value);
  console.error("[admin home] count query failed", result.reason);
  return null;
}
