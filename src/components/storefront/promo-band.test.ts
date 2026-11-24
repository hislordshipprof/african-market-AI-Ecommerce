import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ValidatedStore } from "@/lib/get-store";
import { PromoBand } from "./promo-band";

const delivering = {
  storeDeliveryEnabled: true,
  deliveryRadiusMi: 6,
  lat: 29.76,
  lng: -95.37,
  pickupEnabled: true,
  deliveryInfo: null,
} as unknown as ValidatedStore;

const render = (overrides: Partial<ValidatedStore> = {}, offer?: string) =>
  renderToStaticMarkup(createElement(PromoBand, { store: { ...delivering, ...overrides } as ValidatedStore, offer }));

describe("PromoBand (#783)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("promises local delivery only when the store offers it", () => {
    vi.stubEnv("R2_PROOF_BUCKET", "proof");
    expect(render()).toContain("Local delivery within 6 miles.");
  });

  it("says pickup, not delivery, for a pickup-only store", () => {
    vi.stubEnv("R2_PROOF_BUCKET", "proof");
    const html = render({ storeDeliveryEnabled: false, deliveryInfo: "Free delivery on Saturdays" }, "Free delivery this week");
    expect(html).not.toMatch(/delivery/i);
    expect(html).toMatch(/pick up/i);
  });

  it("does not promise delivery that cannot run without the proof bucket", () => {
    vi.stubEnv("R2_PROOF_BUCKET", "");
    expect(render()).not.toMatch(/delivery/i);
  });
});
