import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoreProfile } from "@/lib/storefront/service";
import { TRUST_COPY, TrustStoryStrip } from "./trust-story-strip";

const profile: StoreProfile = {
  ownerName: "Ada",
  ownerStory: "Serving the block since 2009. We stock home.",
  ownerPhotoUrl: null,
  neighborhood: "Riverside",
  deliveryInfo: null,
  hours: { monday: "9-5" },
  pickupEnabled: true,
  deliveryRadiusMi: 8,
  prepTimeMinutes: 30,
};

describe("TrustStoryStrip", () => {
  it("shows the default trust copy from named constants", () => {
    const html = renderToStaticMarkup(createElement(TrustStoryStrip, { profile }));
    // A prompt that times out takes the store's proposed swap, so the copy may not promise approval.
    expect(html).not.toMatch(/without your approval/i);
    expect(TRUST_COPY.hoursNote).toBe("We ask before any swap.");
    for (const text of Object.values(TRUST_COPY)) expect(html).toContain(text);
  });

  it("shows overridden copy instead of the defaults, keeping defaults for the rest", () => {
    const html = renderToStaticMarkup(createElement(TrustStoryStrip, {
      profile,
      trustCopy: { approvalNote: "We call you before any swap.", hoursNote: "You approve every swap." },
    }));
    expect(html).toContain("We call you before any swap.");
    expect(html).toContain("You approve every swap.");
    expect(html).not.toContain(TRUST_COPY.approvalNote);
    expect(html).not.toContain(TRUST_COPY.hoursNote);
    expect(html).toContain(TRUST_COPY.stepTitle);
    expect(html).toContain(TRUST_COPY.hoursTitle);
  });
});
