import { describe, expect, it } from "vitest";
import { payoutsAlert, storeAdminAddress, storeAdminNav } from "./nav";

const counts = { newOrders: 2, unreadMessages: 3, payoutsAlert: "Needs info" };

function shape(role: string) {
  return storeAdminNav({ role, ...counts }).map((group) => [group.label, group.items.map((item) => item.label)]);
}

describe("storeAdminNav (#860)", () => {
  it("groups the owner's pages as the design does", () => {
    expect(shape("owner")).toEqual([
      [null, ["Home"]],
      ["Sell", ["Orders", "Products", "Purchase orders", "Shipping"]],
      ["Customers", ["Messages"]],
      ["Marketing", ["Promotions", "Directory listing", "WhatsApp"]],
      ["Money", ["Payouts", "Plan"]],
      ["Store", ["Team", "Analytics", "Settings"]],
    ]);
  });

  it("gives staff only the pages their role opens today, and drops empty groups", () => {
    expect(shape("staff")).toEqual([
      [null, ["Home"]],
      ["Sell", ["Orders", "Products"]],
      ["Customers", ["Messages"]],
    ]);
  });

  it("puts the new-order and unread counts on their items, and flags payouts", () => {
    const items = storeAdminNav({ role: "owner", ...counts }).flatMap((group) => group.items);
    expect(items.find((item) => item.label === "Orders")?.count).toBe(2);
    expect(items.find((item) => item.label === "Messages")?.count).toBe(3);
    expect(items.find((item) => item.label === "Payouts")?.alert).toBe("Needs info");
  });

  it("shows no count when there is nothing new", () => {
    const items = storeAdminNav({ role: "owner", newOrders: 0, unreadMessages: 0, payoutsAlert: null }).flatMap((group) => group.items);
    expect(items.every((item) => item.count === undefined && item.alert === undefined)).toBe(true);
  });

  it("links each item to its store-admin path", () => {
    const items = storeAdminNav({ role: "owner", ...counts }).flatMap((group) => group.items);
    expect(items.find((item) => item.label === "Home")?.path).toBe("/store-admin");
    expect(items.find((item) => item.label === "Products")?.path).toBe("/store-admin/listings");
    expect(items.find((item) => item.label === "Directory listing")?.path).toBe("/store-admin/directory");
  });
});

describe("storeAdminAddress (#860 store switcher)", () => {
  it("opens another store's admin on its own address", () => {
    expect(storeAdminAddress("ade-foods", "mama.example.com", { PLATFORM_ROOT_DOMAIN: "example.com" })).toBe("https://ade-foods.example.com/store-admin");
  });

  it("keeps ?store= where the host has no store subdomains", () => {
    expect(storeAdminAddress("ade-foods", "localhost:3000", {})).toBe("http://localhost:3000/store-admin?store=ade-foods");
  });
});

describe("payoutsAlert (#860)", () => {
  it("says what Stripe set-up still needs, and nothing once it is complete", () => {
    expect(payoutsAlert("restricted")).toBe("Needs info");
    expect(payoutsAlert("pending")).toBe("Pending");
    expect(payoutsAlert("not_started")).toBe("Not set up");
    expect(payoutsAlert("complete")).toBeNull();
  });
});
