import { describe, expect, it } from "vitest";
import { closedNotice } from "./closed-notice";

const slots = [
  { value: "2026-11-25T15:00:00.000Z", label: "Wed, Nov 25 · 9:00 AM" },
  { value: "2026-11-25T16:00:00.000Z", label: "Wed, Nov 25 · 10:00 AM" },
];

describe("closedNotice (#811)", () => {
  it("names the chosen slot, not the queue, when a closed store's shopper picks a time", () => {
    expect(closedNotice({ closed: true, shipping: false, scheduled: true, slot: slots[1].value, slots }))
      .toEqual({ kind: "slot", label: "Wed, Nov 25 · 10:00 AM" });
  });

  it("keeps the queue notice for an order placed for when the store opens", () => {
    expect(closedNotice({ closed: true, shipping: false, scheduled: false, slot: "asap", slots }))
      .toEqual({ kind: "queue" });
  });

  it("shows nothing when the store is open, for shipping, or when no time can be chosen", () => {
    expect(closedNotice({ closed: false, shipping: false, scheduled: true, slot: slots[0].value, slots })).toBeNull();
    expect(closedNotice({ closed: true, shipping: true, scheduled: false, slot: "asap", slots })).toBeNull();
    expect(closedNotice({ closed: true, shipping: false, scheduled: true, slot: "asap", slots: [] })).toBeNull();
  });
});
