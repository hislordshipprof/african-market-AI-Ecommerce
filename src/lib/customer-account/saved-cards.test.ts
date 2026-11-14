import { describe, expect, it } from "vitest";
import { isCardExpired } from "./card-expiry";
import { checkoutCardView, type SavedCardFact } from "./checkout-card-view";

const card = (overrides: Partial<SavedCardFact>): SavedCardFact => ({
  id: "pm_1",
  brand: "visa",
  last4: "4242",
  expMonth: 11,
  expYear: 2026,
  consented: true,
  created: 2,
  ...overrides,
});

describe("saved cards view", () => {
  it("card expiry flips at Honolulu month end", () => {
    expect(isCardExpired(11, 2026, new Date("2026-12-01T09:59:59Z"))).toBe(false);
    expect(isCardExpired(11, 2026, new Date("2026-12-01T10:00:00Z"))).toBe(true);
    expect(isCardExpired(10, 2026, new Date("2026-12-01T09:59:59Z"))).toBe(true);
    expect(isCardExpired(12, 2026, new Date("2026-12-01T10:00:00Z"))).toBe(false);
  });

  it("checkoutCardView: guest no tick; signed-in shows the tick; newest unexpired pre-selected; all expired shows form", () => {
    const guest = checkoutCardView({
      signedIn: false,
      cards: [card({})],
      now: new Date("2026-11-15T00:00:00Z"),
    });
    expect(guest.showSaveTick).toBe(false);
    expect(guest.selectable).toEqual([]);
    expect(guest.showCardForm).toBe(true);

    const signedIn = checkoutCardView({
      signedIn: true,
      cards: [
        card({ id: "pm_old", created: 1, expMonth: 12, expYear: 2026 }),
        card({ id: "pm_new", created: 5, expMonth: 12, expYear: 2026 }),
        card({ id: "pm_secret", created: 9, consented: false, expMonth: 12, expYear: 2026 }),
      ],
      now: new Date("2026-11-15T00:00:00Z"),
    });
    expect(signedIn.showSaveTick).toBe(true);
    expect(signedIn.preselectedId).toBe("pm_new");
    expect(signedIn.showCardForm).toBe(false);
    expect(signedIn.selectable.map((item) => item.id)).toEqual(["pm_new", "pm_old"]);

    const expired = checkoutCardView({
      signedIn: true,
      cards: [card({ expMonth: 10, expYear: 2026 })],
      now: new Date("2026-12-01T10:00:00Z"),
    });
    expect(expired.preselectedId).toBeNull();
    expect(expired.selectable).toEqual([]);
    expect(expired.showCardForm).toBe(true);
    expect(expired.expired).toHaveLength(1);
  });
});
