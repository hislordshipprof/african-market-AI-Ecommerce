import { beforeEach, describe, expect, it, vi } from "vitest";

const listStores = vi.fn();
const listRefundFailedOrders = vi.fn();
const listOrdersToCheck = vi.fn();
const listEscalatedThreads = vi.fn();
const getReviewStats = vi.fn();
const listStoreApplications = vi.fn();
const requestsByArea = vi.fn();
const findCourierIncidents = vi.fn();
const readOpenDisputes = vi.fn();

vi.mock("./actions", () => ({ listStores: () => listStores() }));
vi.mock("./refund-resolution", () => ({ listRefundFailedOrders: () => listRefundFailedOrders() }));
vi.mock("./orders-to-check", () => ({ listOrdersToCheck: () => listOrdersToCheck() }));
vi.mock("../support/platform-actions", () => ({ listEscalatedThreads: () => listEscalatedThreads() }));
vi.mock("./catalog-actions", () => ({ getReviewStats: () => getReviewStats() }));
vi.mock("../store-application/service", () => ({
  PENDING_APPLICATIONS_LISTED: 3,
  listStoreApplications: () => listStoreApplications(),
}));

vi.mock("../directory/store-requests", () => ({ requestsByArea: () => requestsByArea() }));
vi.mock("./courier-incidents-query", () => ({ findCourierIncidents: (_tx: unknown, filters: unknown, limit: unknown) => findCourierIncidents(filters, limit) }));
vi.mock("./disputes", () => ({ readOpenDisputes: () => readOpenDisputes() }));
vi.mock("../db", () => ({ platformAdminTransaction: (run: (tx: unknown) => unknown) => run({}) }));

import { getAdminHomeCounts } from "./home-counts";

function queues(overrides: { stuck?: number; alerts?: number; cappedGroups?: string[]; alertsCapped?: boolean } = {}) {
  return {
    checkedAt: new Date(),
    stuck: Array.from({ length: overrides.stuck ?? 0 }, (_, i) => ({ orderId: `s${i}` })),
    alerts: Array.from({ length: overrides.alerts ?? 0 }, (_, i) => ({ orderId: `a${i}` })),
    cappedGroups: overrides.cappedGroups ?? [],
    alertsCapped: overrides.alertsCapped ?? false,
  };
}

describe("getAdminHomeCounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listStores.mockResolvedValue([{ status: "active" }, { status: "suspended" }, { status: "active" }, { status: "setup" }]);
    listRefundFailedOrders.mockResolvedValue([{ orderId: "o1" }, { orderId: "o2" }]);
    listOrdersToCheck.mockResolvedValue(queues({ stuck: 2, alerts: 3 }));
    listEscalatedThreads.mockResolvedValue({ threads: [{ id: "t1", waiting: true }, { id: "t2", waiting: false }], hidden: 0 });
    getReviewStats.mockResolvedValue({ needsReview: 313, active: 230, rejected: 5, total: 548 });
    listStoreApplications.mockResolvedValue({ pending: [{ id: "p1" }, { id: "p2" }], decided: [{ id: "d1" }] });
    requestsByArea.mockResolvedValue([{ state: "TX", zips: [{ zip: "77001", waiting: 3 }, { zip: "77002", waiting: 1 }] }, { state: "MD", zips: [{ zip: "20901", waiting: 2 }] }]);
    findCourierIncidents.mockResolvedValue({ rows: [{ state: "open" }, { state: "resolved" }, { state: "open" }], nextCursor: null });
    readOpenDisputes.mockResolvedValue({ rows: [{ id: "d1" }], more: false });
  });

  it("counts every queue from its existing query, messages only when they wait on the platform team", async () => {
    expect(await getAdminHomeCounts()).toEqual({
      stores: { total: 4, active: 2, setup: 1, suspended: 1 },
      refunds: { count: 2, incomplete: false },
      ordersToCheck: { count: 5, incomplete: false },
      messages: { count: 1, incomplete: false },
      catalogReview: { count: 313, incomplete: false },
      applications: { count: 2, incomplete: false },
      storeRequests: { count: 6, incomplete: false },
      courierIncidents: { count: 2, incomplete: false },
      disputes: { count: 1, incomplete: false },
    });
  });

  it("marks a count incomplete when its list was capped", async () => {
    listOrdersToCheck.mockResolvedValue(queues({ stuck: 1, cappedGroups: ["authorized"] }));
    listEscalatedThreads.mockResolvedValue({ threads: [{ id: "t1", waiting: true }], hidden: 4 });
    const counts = await getAdminHomeCounts();
    expect(counts.ordersToCheck).toEqual({ count: 1, incomplete: true });
    expect(counts.messages).toEqual({ count: 1, incomplete: true });

    listEscalatedThreads.mockResolvedValue({ threads: [{ id: "t1", waiting: true }, { id: "t2", waiting: false }], hidden: 3 });
    listOrdersToCheck.mockResolvedValue(queues({ alerts: 2, alertsCapped: true }));
    expect((await getAdminHomeCounts()).messages).toEqual({ count: 1, incomplete: false });
    expect((await getAdminHomeCounts()).ordersToCheck).toEqual({ count: 2, incomplete: true });

    listStoreApplications.mockResolvedValue({ pending: [{ id: "p1" }, { id: "p2" }, { id: "p3" }], decided: [] });
    expect((await getAdminHomeCounts()).applications).toEqual({ count: 3, incomplete: true });

    findCourierIncidents.mockResolvedValue({ rows: [{ state: "open" }], nextCursor: "next" });
    readOpenDisputes.mockResolvedValue({ rows: [{ id: "d1" }, { id: "d2" }], more: true });
    const capped = await getAdminHomeCounts();
    expect(capped.courierIncidents).toEqual({ count: 1, incomplete: true });
    expect(capped.disputes).toEqual({ count: 2, incomplete: true });
  });

  it("keeps the other counts when one query fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    listOrdersToCheck.mockRejectedValue(new Error("statement timeout"));
    listStores.mockRejectedValue(new Error("statement timeout"));

    const counts = await getAdminHomeCounts();

    expect(counts.ordersToCheck).toBeNull();
    expect(counts.stores).toBeNull();
    expect(counts.refunds).toEqual({ count: 2, incomplete: false });
    expect(counts.catalogReview).toEqual({ count: 313, incomplete: false });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
