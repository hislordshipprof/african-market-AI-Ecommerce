import { describe, expect, it } from "vitest";
import { filterOrders, orderTabCounts } from "./order-tabs";

const order = (id: string, status: string, extra: Partial<{ number: number; name: string; fulfillment: string }> = {}) => ({
  id,
  status,
  number: extra.number ?? 1000,
  fulfillment: extra.fulfillment ?? "pickup",
  customer: { name: extra.name ?? "Kemi Adeyemi" },
});

const orders = [
  order("a", "AUTHORIZED", { number: 1052 }),
  order("b", "AUTHORIZED", { number: 1051, name: "Chinedu Obi", fulfillment: "store-delivery" }),
  order("c", "SUBSTITUTION_PENDING", { number: 1050, name: "Funmi Bello" }),
  order("d", "PICKING", { number: 1049 }),
  order("e", "ACCEPTED", { number: 1048, fulfillment: "ship" }),
  order("f", "READY", { number: 1047 }),
  order("g", "AWAITING_PICKUP", { number: 1046 }),
  order("h", "OUT_FOR_DELIVERY", { number: 1045, fulfillment: "store-delivery" }),
  order("i", "REFUND_FAILED", { number: 1044 }),
];

describe("order tabs (#860)", () => {
  it("counts each stage, and shows a stage only when it has orders", () => {
    expect(orderTabCounts(orders)).toEqual([
      { tab: "all", label: "All active", count: 9 },
      { tab: "placed", label: "Order placed", count: 2 },
      { tab: "packing", label: "Packing", count: 2 },
      { tab: "swap", label: "Swap choice", count: 1 },
      { tab: "ready", label: "Ready", count: 2 },
      { tab: "out", label: "Out", count: 1 },
      { tab: "other", label: "Needs a look", count: 1 },
    ]);
    expect(orderTabCounts([order("a", "AUTHORIZED")]).map((tab) => tab.tab)).toEqual(["all", "placed", "packing", "swap", "ready", "out"]);
  });

  it("filters by stage, fulfilment, and an order number or customer name", () => {
    expect(filterOrders(orders, { tab: "placed", fulfillment: "all", query: "" }).map((o) => o.id)).toEqual(["a", "b"]);
    expect(filterOrders(orders, { tab: "all", fulfillment: "store-delivery", query: "" }).map((o) => o.id)).toEqual(["b", "h"]);
    expect(filterOrders(orders, { tab: "all", fulfillment: "all", query: "funmi" }).map((o) => o.id)).toEqual(["c"]);
    expect(filterOrders(orders, { tab: "all", fulfillment: "all", query: "#1049" }).map((o) => o.id)).toEqual(["d"]);
    expect(filterOrders(orders, { tab: "all", fulfillment: "all", query: "  " })).toHaveLength(9);
  });
});
