import { beforeEach, describe, expect, it, vi } from "vitest";

const listStores = vi.fn();
const listRefundFailedOrders = vi.fn();
const listOrdersToCheck = vi.fn();
const listEscalatedThreads = vi.fn();
const getReviewStats = vi.fn();

vi.mock("./actions", () => ({ listStores: () => listStores() }));
vi.mock("./refund-resolution", () => ({ listRefundFailedOrders: () => listRefundFailedOrders() }));
vi.mock("./orders-to-check", () => ({ listOrdersToCheck: () => listOrdersToCheck() }));
vi.mock("../support/platform-actions", () => ({ listEscalatedThreads: () => listEscalatedThreads() }));
vi.mock("./catalog-actions", () => ({ getReviewStats: () => getReviewStats() }));

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
    listStores.mockResolvedValue([]);
    listRefundFailedOrders.mockResolvedValue([]);
    listOrdersToCheck.mockResolvedValue(queues());
    listEscalatedThreads.mockResolvedValue({ threads: [], hidden: 0 });
    getReviewStats.mockResolvedValue({ needsReview: 0, active: 0, rejected: 0, total: 0 });
  });

  it("counts active and suspended stores apart", async () => {
    listStores.mockResolvedValue([{ status: "active" }, { status: "suspended" }, { status: "active" }]);
    const counts = await getAdminHomeCounts();
    expect(counts.stores).toEqual({ active: 2, suspended: 1 });
  });

  it("counts every queue from its existing query", async () => {
    listRefundFailedOrders.mockResolvedValue([{ orderId: "o1" }, { orderId: "o2" }]);
    listOrdersToCheck.mockResolvedValue(queues({ stuck: 2, alerts: 3 }));
    listEscalatedThreads.mockResolvedValue({ threads: [{ id: "t1" }], hidden: 4 });
    getReviewStats.mockResolvedValue({ needsReview: 313, active: 230, rejected: 5, total: 548 });

    const counts = await getAdminHomeCounts();

    expect(counts.refunds).toBe(2);
    expect(counts.ordersToCheck).toEqual({ count: 5, incomplete: false });
    expect(counts.messages).toBe(5);
    expect(counts.catalogReview).toBe(313);
  });

  it("marks the orders count incomplete when the check list was capped", async () => {
    listOrdersToCheck.mockResolvedValue(queues({ stuck: 1, cappedGroups: ["authorized"] }));
    expect((await getAdminHomeCounts()).ordersToCheck).toEqual({ count: 1, incomplete: true });

    listOrdersToCheck.mockResolvedValue(queues({ alerts: 2, alertsCapped: true }));
    expect((await getAdminHomeCounts()).ordersToCheck).toEqual({ count: 2, incomplete: true });
  });

  it("returns zeros when every queue is empty", async () => {
    expect(await getAdminHomeCounts()).toEqual({
      stores: { active: 0, suspended: 0 },
      refunds: 0,
      ordersToCheck: { count: 0, incomplete: false },
      messages: 0,
      catalogReview: 0,
    });
  });
});
