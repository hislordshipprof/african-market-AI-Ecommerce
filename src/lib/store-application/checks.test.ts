import { describe, expect, it } from "vitest";
import { applicationChecks } from "./checks";

const application = {
  id: "app-1",
  businessName: "Mama Ngozi Foods",
  addressLine1: "12 Main St",
  city: "Hyattsville",
  state: "MD",
  zip: "20782",
  email: "ngozi@example.com",
  website: "https://ngozi.example",
  offersPickup: true,
  offersDelivery: false,
};
const metros = [{ name: "DC Metro", states: ["DC", "MD", "VA"] }];

describe("applicationChecks (#832)", () => {
  it("passes an application with every field, no duplicate and a state in a metro", () => {
    expect(applicationChecks(application, { stores: [], metros, pending: [application] })).toEqual({
      suggestedSlug: "mama-ngozi-foods",
      missing: [],
      duplicates: [],
      metro: "DC Metro",
      outsideMetro: false,
    });
  });

  it("names missing details, each duplicate and an address outside every metro", () => {
    const thin = { ...application, website: null, offersPickup: false, state: "TX" };
    const stores = [
      { name: "Mama Ngozi Foods", slug: "mama-ngozi-foods", addressLine1: null, zip: null },
      { name: "Other", slug: "other", addressLine1: "12 main st", zip: "20782" },
    ];
    const twin = { ...application, id: "app-2", businessName: "Ngozi Two" };
    const checks = applicationChecks(thin, { stores, metros, pending: [thin, twin] });
    expect(checks.missing).toEqual(["no website or social link", "offers neither pickup nor delivery"]);
    expect(checks.duplicates).toEqual([
      "the slug mama-ngozi-foods is taken by Mama Ngozi Foods, so approve needs another slug",
      "a store named Mama Ngozi Foods already exists",
      "Other is at the same address",
      "another waiting application, Ngozi Two, uses the same email",
      "another waiting application, Ngozi Two, is at the same address",
    ]);
    expect(checks.metro).toBeNull();
    expect(checks.outsideMetro).toBe(true);
  });
});
