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
  neighborhood: "Parkside",
  hours: null,
  timezone: "America/Chicago",
  pickupEnabled: true,
  storeDeliveryEnabled: true,
  storeDeliveryFeeCents: 499,
  listingBlurb: "Nigerian and West African groceries since 2009.",
  cuisineTags: ["west-african"],
  ownerName: "Ngozi Okafor",
  ownerStory: "What started as a small shop is now the neighbourhood's go-to.",
  ownerPhotoUrl: null,
  courierMayDeliver: false,
  href: "http://mama-ngozi.localhost/",
};

const card = (over: Partial<CardStore> = {}) => renderToStaticMarkup(createElement(StoreCard, { store: { ...store, ...over } }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

function nearMe(stores: CardStore[]) {
  return renderToStaticMarkup(createElement(NearMe, { stores, chips: [], intro: null, owner: null, figure: null }));
}

describe("store card (#863 AC3)", () => {
  it("names the area and cuisines, and the store's own delivery fee next to its delivery", () => {
    const html = text(card());
    expect(html).toContain("Parkside, West African");
    expect(html).toContain("Delivery $4.99 delivery");
    expect(html).toContain("Pickup");
  });

  it("shows no fee when the store's own delivery has none, and never a delivery time", () => {
    const html = text(card({ storeDeliveryFeeCents: 0 }));
    expect(html).toContain("Delivery");
    expect(html).not.toContain("$");
    expect(html).not.toMatch(/\bmin\b|minutes|hour/);
  });

  it("gives a courier store no price: its fee is only known from a quote", () => {
    const html = text(card({ storeDeliveryEnabled: false, storeDeliveryFeeCents: null, courierMayDeliver: true }));
    expect(html).toContain("Courier may be available");
    expect(html).not.toContain("$");
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

  it("shows no cuisine filter before a search (#863 AC2)", () => {
    const html = renderToStaticMarkup(createElement(NearMe, { stores: [store], chips: [{ value: "west-african", label: "West African" }], intro: null, owner: null, figure: null }));
    expect(html).not.toContain("Filter markets by cuisine");
  });
});
