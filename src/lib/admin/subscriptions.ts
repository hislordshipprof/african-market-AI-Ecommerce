import { listSubscriptionOverviewRows, type SubscriptionOverviewRow } from "../db";
import { effectivePlan, PLAN_PRICES_USD, type Plan } from "../billing/plan";
import { requirePlatformAdmin } from "./session";

/** Stripe's MRR: subscriptions that bill now. Trials and the pilot's free months are left out. */
const MRR_STATUSES = new Set(["active", "past_due"]);

export interface SubscriptionTotals {
  mrrCents: number;
  stores: number;
  overrides: number;
  byStatus: Record<string, number>;
}

/** MRR is what Stripe bills, so a comped override adds nothing. */
export function subscriptionTotals(rows: readonly SubscriptionOverviewRow[]): SubscriptionTotals {
  const totals: SubscriptionTotals = { mrrCents: 0, stores: rows.length, overrides: 0, byStatus: {} };
  for (const row of rows) {
    totals.byStatus[row.status] = (totals.byStatus[row.status] ?? 0) + 1;
    if (row.overridePlan) totals.overrides += 1;
    if (MRR_STATUSES.has(row.status) && !row.inFreeMonths && (row.plan === "starter" || row.plan === "pro")) {
      totals.mrrCents += PLAN_PRICES_USD[row.plan] * 100;
    }
  }
  return totals;
}

export interface SubscriptionFilters {
  status?: string;
  plan?: Plan;
}

/** Plan is the one the store runs on, override included. */
export function filterSubscriptions(rows: readonly SubscriptionOverviewRow[], filters: SubscriptionFilters): SubscriptionOverviewRow[] {
  return rows.filter(
    (row) => (!filters.status || row.status === filters.status) && (!filters.plan || effectivePlan(row) === filters.plan),
  );
}

export interface FilterOptionCounts {
  status: Record<string, number>;
  plan: Record<string, number>;
}

/** How many stores each option would return with the other filter held; "" is the "All" option. */
export function filterOptionCounts(
  rows: readonly SubscriptionOverviewRow[],
  filters: SubscriptionFilters,
  options: { statuses: readonly string[]; plans: readonly Plan[] },
): FilterOptionCounts {
  const count = (f: SubscriptionFilters) => filterSubscriptions(rows, f).length;
  const status: Record<string, number> = { "": count({ plan: filters.plan }) };
  for (const s of options.statuses) status[s] = count({ status: s, plan: filters.plan });
  const plan: Record<string, number> = { "": count({ status: filters.status }) };
  for (const p of options.plans) plan[p] = count({ status: filters.status, plan: p });
  return { status, plan };
}

export async function listSubscriptions(): Promise<SubscriptionOverviewRow[]> {
  await requirePlatformAdmin();
  return listSubscriptionOverviewRows();
}
