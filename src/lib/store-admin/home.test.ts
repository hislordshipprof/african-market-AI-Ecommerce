import { describe, expect, it } from "vitest";
import { compareToLastWeek, needsYouNow } from "./home-needs";

const now = new Date("2026-11-25T18:00:00Z");
const none = {
  storeSlug: "mama",
  isOwner: true,
  now,
  newOrders: { count: 0, oldestAt: null },
  swaps: [],
  payoutsAlert: null,
  lowStock: { count: 0, names: [] },
  unreadMessages: 0,
  goLive: [],
};

describe("needsYouNow (#860)", () => {
  it("is empty when nothing waits", () => {
    expect(needsYouNow(none)).toEqual([]);
  });

  it("links each waiting job to the page that fixes it, orders first", () => {
    const items = needsYouNow({
      ...none,
      newOrders: { count: 2, oldestAt: new Date(now.getTime() - 27 * 60_000) },
      swaps: [{ id: "o50", number: 1050, customerName: "Funmi Bello" }],
      payoutsAlert: "Needs info",
      lowStock: { count: 6, names: ["Ugu", "Ata rodo"] },
      unreadMessages: 2,
      goLive: [{ key: "listings", label: "Add 10 products", detail: "4 of 10", done: false, href: "/store-admin/listings?store=mama" }],
    });
    expect(items.map((item) => [item.title, item.href])).toEqual([
      ["Accept 2 new orders", "/store-admin/orders?store=mama"],
      ["Funmi Bello is choosing a swap on #1050", "/store-admin/orders/o50?store=mama"],
      ["Payouts: Needs info", "/store-admin/payouts?store=mama"],
      ["6 products are running low", "/store-admin/listings?store=mama"],
      ["2 unread messages", "/store-admin/messages?store=mama"],
      ["Add 10 products", "/store-admin/listings?store=mama"],
    ]);
    expect(items[0].detail).toBe("Oldest placed 27 minutes ago");
    expect(items[3].detail).toBe("Ugu and Ata rodo first");
  });

  it("speaks of one order, one message and one product in the singular", () => {
    const items = needsYouNow({
      ...none,
      newOrders: { count: 1, oldestAt: new Date(now.getTime() - 60_000) },
      lowStock: { count: 1, names: ["Garri"] },
      unreadMessages: 1,
    });
    expect(items.map((item) => item.title)).toEqual(["Accept 1 new order", "1 product is running low", "1 unread message"]);
    expect(items[0].detail).toBe("Placed 1 minute ago");
  });

  it("leaves payouts and done or unlinked checklist items out", () => {
    const items = needsYouNow({
      ...none,
      isOwner: false,
      payoutsAlert: "Needs info",
      goLive: [
        { key: "listings", label: "Done one", detail: "", done: true, href: "/x" },
        { key: "payouts", label: "Owner only", detail: "", done: false },
      ],
    });
    expect(items).toEqual([]);
  });
});

describe("compareToLastWeek (#860)", () => {
  it("gives the change in whole percent, and nothing without last week's sales", () => {
    expect(compareToLastWeek(112_00, 100_00)).toBe(12);
    expect(compareToLastWeek(90_00, 100_00)).toBe(-10);
    expect(compareToLastWeek(50_00, 0)).toBeNull();
  });
});
