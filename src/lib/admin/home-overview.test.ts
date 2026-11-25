import { describe, expect, it } from "vitest";
import { homeOverview } from "./home-overview";

const day = (d: string, orders: number, goodsCents: number) => ({ day: d, orders, goodsCents });
const sold = (storeId: string, today: number, todayOrders: number) => ({ storeId, orders: todayOrders, goodsCents: today, today: { orders: todayOrders, goodsCents: today } });

describe("homeOverview", () => {
  const stores = [
    { id: "a", name: "Mama Ngozi", metroId: "hou" },
    { id: "b", name: "Tante Marie", metroId: "dmv" },
    { id: "c", name: "Lagos Fresh", metroId: "hou" },
    { id: "d", name: "No Metro Mart", metroId: null },
    { id: "e", name: "Quiet Shop", metroId: "hou" },
  ];
  const metros = [{ id: "hou", name: "Houston" }, { id: "dmv", name: "Silver Spring" }];
  const days = [day("2026-11-18", 4, 10000), ...["19", "20", "21", "22", "23", "24"].map((d) => day(`2026-11-${d}`, 1, 500)), day("2026-11-25", 6, 12500)];

  it("reads today, a week of days for the sparkline, and the change on the same weekday last week", () => {
    const view = homeOverview({ days, sales: [], stores, metros });
    expect(view.today).toEqual({ orders: 6, goodsCents: 12500, weekAgoGoodsCents: 10000, changePercent: 25 });
    expect(view.spark.map((point) => point.goodsCents)).toEqual([500, 500, 500, 500, 500, 500, 12500]);
  });

  it("has no change when last week sold nothing", () => {
    const quiet = [day("2026-11-18", 0, 0), ...days.slice(1)];
    expect(homeOverview({ days: quiet, sales: [], stores, metros }).today.changePercent).toBeNull();
  });

  it("ranks today's stores by sales with their metro, and adds today's sales up by metro", () => {
    const view = homeOverview({ days, sales: [sold("a", 2140, 46), sold("b", 1420, 31), sold("c", 3000, 29), sold("d", 900, 3), sold("e", 0, 0)], stores, metros });
    expect(view.storesToday).toEqual([
      { id: "c", name: "Lagos Fresh", metro: "Houston", goodsCents: 3000, orders: 29 },
      { id: "a", name: "Mama Ngozi", metro: "Houston", goodsCents: 2140, orders: 46 },
      { id: "b", name: "Tante Marie", metro: "Silver Spring", goodsCents: 1420, orders: 31 },
      { id: "d", name: "No Metro Mart", metro: null, goodsCents: 900, orders: 3 },
    ]);
    expect(view.byMetro).toEqual([
      { metro: "Houston", goodsCents: 5140 },
      { metro: "Silver Spring", goodsCents: 1420 },
      { metro: null, goodsCents: 900 },
    ]);
  });

  it("skips a sales row whose store is gone", () => {
    expect(homeOverview({ days, sales: [sold("zz", 500, 1)], stores, metros }).storesToday).toEqual([]);
  });
});
