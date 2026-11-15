import { describe, expect, it } from "vitest";
import type { SubscriptionOverviewRow } from "../db";
import { filterSubscriptions, subscriptionTotals } from "./subscriptions";

function row(over: Partial<SubscriptionOverviewRow>): SubscriptionOverviewRow {
  return {
    storeId: "s",
    storeName: "S",
    storeSlug: "s",
    plan: "starter",
    status: "active",
    pilot: false,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    paymentFailedAt: null,
    overridePlan: null,
    overrideEndsAt: null,
    overrideReason: null,
    inFreeMonths: false,
    ...over,
  };
}

describe("subscriptionTotals (#547)", () => {
  it("MRR counts active and past_due at the Stripe plan price, in cents", () => {
    const totals = subscriptionTotals([
      row({ storeId: "a", plan: "pro", status: "active" }),
      row({ storeId: "b", plan: "starter", status: "past_due" }),
      row({ storeId: "c", plan: "pro", status: "active", cancelAtPeriodEnd: true }),
    ]);
    expect(totals.mrrCents).toBe(9_900 + 4_900 + 9_900);
  });

  it("MRR leaves out trials, pilot free months, cancelled, unpaid, incomplete and never-subscribed stores", () => {
    const totals = subscriptionTotals([
      row({ storeId: "a", plan: "pro", status: "trialing" }),
      row({ storeId: "b", plan: "pro", status: "active", pilot: true, inFreeMonths: true }),
      row({ storeId: "c", plan: "pro", status: "canceled" }),
      row({ storeId: "d", plan: "pro", status: "unpaid" }),
      row({ storeId: "e", plan: "pro", status: "incomplete" }),
      row({ storeId: "f", plan: "starter", status: "none" }),
    ]);
    expect(totals.mrrCents).toBe(0);
  });

  it("a pilot store past its free months counts; a comped Pro override adds nothing over what Stripe bills", () => {
    const totals = subscriptionTotals([
      row({ storeId: "a", plan: "starter", status: "active", pilot: true, inFreeMonths: false }),
      row({ storeId: "b", plan: "starter", status: "active", overridePlan: "pro" }),
      row({ storeId: "c", plan: "starter", status: "none", overridePlan: "pro" }),
    ]);
    expect(totals.mrrCents).toBe(4_900 + 4_900);
  });

  it("counts every store by Stripe status, and running overrides", () => {
    const totals = subscriptionTotals([
      row({ storeId: "a", status: "active" }),
      row({ storeId: "b", status: "active", overridePlan: "pro" }),
      row({ storeId: "c", status: "past_due" }),
      row({ storeId: "d", status: "none" }),
    ]);
    expect(totals.byStatus).toEqual({ active: 2, past_due: 1, none: 1 });
    expect(totals.stores).toBe(4);
    expect(totals.overrides).toBe(1);
  });
});

describe("filterSubscriptions (#547)", () => {
  const rows = [
    row({ storeId: "a", plan: "pro", status: "active" }),
    row({ storeId: "b", plan: "starter", status: "past_due" }),
    row({ storeId: "c", plan: "starter", status: "active", overridePlan: "pro" }),
  ];

  it("filters by exact Stripe status and by the plan the store runs on", () => {
    expect(filterSubscriptions(rows, { status: "active" }).map((r) => r.storeId)).toEqual(["a", "c"]);
    expect(filterSubscriptions(rows, { plan: "pro" }).map((r) => r.storeId)).toEqual(["a", "c"]);
    expect(filterSubscriptions(rows, { plan: "starter", status: "past_due" }).map((r) => r.storeId)).toEqual(["b"]);
    expect(filterSubscriptions(rows, {}).length).toBe(3);
  });
});
