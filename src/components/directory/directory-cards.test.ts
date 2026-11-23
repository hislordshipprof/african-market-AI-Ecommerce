import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NearMe } from "./near-me";
import { StoreCard, type CardStore } from "./store-card";

const store: CardStore = {
  name: "Mama Ngozi African Market",
  slug: "mama-ngozi",
  logoUrl: null,
  brandColor: null,
  city: "Houston",
  state: "TX",
  neighborhood: null,
  hours: null,
  timezone: "America/Chicago",
  pickupEnabled: true,
  storeDeliveryEnabled: true,
  listingBlurb: "Nigerian and West African groceries since 2009.",
  cuisineTags: ["west-african"],
  ownerName: "Ngozi Okafor",
  ownerStory: "What started as a small shop is now the neighbourhood's go-to.",
  ownerPhotoUrl: null,
  courierMayDeliver: false,
  href: "http://mama-ngozi.localhost/",
} as CardStore;

function nearMe(stores: CardStore[]) {
  return renderToStaticMarkup(
    createElement(NearMe, { states: [], stores, chips: [], backdrop: null, intro: null, counts: null }),
  );
}

describe("store card (#728 AC3)", () => {
  it("shows pickup and delivery before the blurb and the owner's story", () => {
    const html = renderToStaticMarkup(createElement(StoreCard, { store }));
    const pickup = html.indexOf("Pickup");
    expect(pickup).toBeGreaterThan(html.indexOf("Mama Ngozi African Market"));
    expect(pickup).toBeLessThan(html.indexOf(store.listingBlurb!));
    expect(pickup).toBeLessThan(html.indexOf("Run by Ngozi Okafor"));
  });
});

describe("empty directory (#728 AC2)", () => {
  it("offers the tell-me-when-a-store-opens form instead of only asking people to check back", () => {
    const html = nearMe([]);
    expect(html).toContain("No stores are listed yet");
    expect(html).toContain("Tell me when a store opens near me");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Notify me<\/button>/);
    expect(html).not.toContain("Check back soon");
  });

  it("keeps the form off a directory that has stores", () => {
    expect(nearMe([store])).not.toContain("Tell me when a store opens near me");
  });
});
