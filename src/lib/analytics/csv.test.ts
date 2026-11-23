import { describe, expect, it } from "vitest";
import { analyticsCsv } from "./csv";
import { salesView, type StoreAnalytics } from "./queries";

const range = { preset: "custom" as const, from: "2026-11-02", to: "2026-11-02" };

type MoneyRow = Parameters<typeof salesView>[0][number];

function row(fulfillment: string, capturedCents: number): MoneyRow {
  return {
    kind: "order",
    day: "2026-11-02",
    fulfillment,
    orders: 1,
    goods: capturedCents,
    discounts: 0,
    card_fee: 0,
    service_fee: 0,
    courier_fee: 0,
    captured: capturedCents,
    refunds: 0,
    refund_store_cost: 0,
  };
}

function salesCsv(rows: MoneyRow[]): string[][] {
  const sales = salesView(rows, range);
  const data = { range, sales } as unknown as StoreAnalytics;
  return analyticsCsv("sales", data, { chats: 0, cap: 0 }).trim().split("\r\n").map((line) => line.split(","));
}

describe("sales CSV by fulfilment", () => {
  it("counts a store-delivery order under Store delivery, in words", () => {
    const csv = salesCsv([row("store-delivery", 4819)]);
    const delivery = csv.find((cells) => cells[0] === "Store delivery");
    expect(delivery?.[1]).toBe("1");
    expect(csv.some((cells) => cells[0] === "store-delivery" || cells[0] === "store_delivery")).toBe(false);
  });

  it("names every fulfilment in words", () => {
    const csv = salesCsv([row("pickup", 1000), row("courier", 2000), row("ship", 3000)]);
    const firstCells = csv.map((cells) => cells[0]);
    expect(firstCells).toEqual(expect.arrayContaining(["Pickup", "Store delivery", "Courier delivery", "Shipping"]));
  });
});
