import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ValidatedStore } from "@/lib/get-store";
import { StorefrontFooter } from "./storefront-footer";

const store = {
  name: "Mama Ada Market",
  neighborhood: "Riverside",
  ownerName: null,
  ownerStory: null,
  addressLine1: "12 Main St",
  addressLine2: "Suite 4",
  city: "Houston",
  state: "TX",
  zip: "77001",
  phone: "+17135550100",
  hours: { mon: "9:00-17:00", sat: { closed: true } },
} as unknown as ValidatedStore;

const render = (overrides: Partial<ValidatedStore> = {}) =>
  renderToStaticMarkup(createElement(StorefrontFooter, { store: { ...store, ...overrides } as ValidatedStore }));

describe("StorefrontFooter (#783)", () => {
  it("shows where the store is, how to call it and when it is open", () => {
    const html = render();
    expect(html).toContain("12 Main St, Suite 4, Houston, TX 77001");
    expect(html).toContain('href="tel:+17135550100"');
    expect(html).toContain("(713) 555-0100");
    expect(html).toMatch(/Mon<\/dt><dd>9 AM – 5 PM/);
    expect(html).toMatch(/Sat<\/dt><dd>Closed/);
  });

  it("never shows the platform's brand", () => {
    expect(render()).not.toMatch(/Powered by/i);
  });

  it("leaves out what the store has not set", () => {
    const html = render({ addressLine1: null, city: null, state: null, zip: null, phone: null, hours: null });
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("<address");
    expect(html).not.toContain("<dl");
  });
});
