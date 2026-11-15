import Link from "next/link";
import { filterSubscriptions, listSubscriptions, subscriptionTotals } from "@/lib/admin/subscriptions";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { billingStatusLabel, effectivePlan, PLAN_NAMES, type Plan } from "@/lib/billing/plan";

export const metadata = { title: "Subscriptions — Platform Admin" };

/** Stripe statuses in the order an admin reads them; "none" is a store that never subscribed. */
const STATUSES = ["active", "past_due", "trialing", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused", "none"] as const;
const PLANS: readonly Plan[] = ["starter", "pro"];

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const FIELD = "min-h-11 rounded-lg border border-input bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function day(value: Date | null) {
  return value ? <time dateTime={value.toISOString()}>{dateFormat.format(value)}</time> : <span className="text-muted-foreground">—</span>;
}

export default async function SubscriptionsPage({ searchParams }: { searchParams: Promise<{ status?: string; plan?: string }> }) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const status = STATUSES.find((s) => s === params.status);
  const plan = PLANS.find((p) => p === params.plan);
  const all = await listSubscriptions();
  const totals = subscriptionTotals(all);
  const rows = filterSubscriptions(all, { status, plan });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Subscriptions</h1>
      <p className="mt-1 max-w-prose text-muted-foreground">
        Every store&apos;s plan and Stripe status. Set a plan override from the store&apos;s page.
      </p>

      <section aria-labelledby="totals-title" className="mt-8">
        <h2 id="totals-title" className="sr-only">Totals</h2>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_1fr]">
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <p className="text-sm text-muted-foreground">Monthly recurring revenue</p>
            <p className="mt-1 font-heading text-[28px] font-bold leading-none tabular-nums text-foreground" data-testid="mrr">
              {usd.format(totals.mrrCents / 100)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">Active and payment-failed subscriptions, as Stripe counts it. Free trials, pilot free months and overrides add nothing.</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <p className="text-sm text-muted-foreground">
              {totals.stores} {totals.stores === 1 ? "store" : "stores"} · {totals.overrides} with a plan override
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3" data-testid="status-counts">
              {STATUSES.filter((s) => totals.byStatus[s]).map((s) => (
                <div key={s} className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">{billingStatusLabel(s)}</dt>
                  <dd className="font-semibold tabular-nums text-foreground">{totals.byStatus[s]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <section aria-labelledby="list-title" className="mt-10">
        <h2 id="list-title" className="text-lg font-semibold text-foreground">Stores</h2>
        <form method="get" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-foreground">
            Status
            <select name="status" defaultValue={status ?? ""} className={FIELD}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{billingStatusLabel(s)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-foreground">
            Plan
            <select name="plan" defaultValue={plan ?? ""} className={FIELD}>
              <option value="">All plans</option>
              {PLANS.map((p) => (
                <option key={p} value={p}>{PLAN_NAMES[p]}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="min-h-11 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Filter
          </button>
          {(status || plan) && (
            <Link href="/admin/billing/subscriptions" className="flex min-h-11 items-center px-2 text-sm text-primary underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </form>

        {rows.length === 0 ? (
          <p className="mt-4 rounded-xl border border-border bg-card p-6 text-muted-foreground">No stores match these filters.</p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[56rem] text-sm" data-testid="subscriptions-table">
              <caption className="sr-only">Stores with their plan and Stripe subscription</caption>
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th scope="col" className="px-4 py-2 font-medium">Store</th>
                  <th scope="col" className="px-3 py-2 font-medium">Plan</th>
                  <th scope="col" className="px-3 py-2 font-medium">Stripe status</th>
                  <th scope="col" className="px-3 py-2 font-medium">Pilot</th>
                  <th scope="col" className="px-3 py-2 font-medium">Trial ends</th>
                  <th scope="col" className="px-3 py-2 font-medium">Period ends</th>
                  <th scope="col" className="px-3 py-2 font-medium">Cancels at period end</th>
                  <th scope="col" className="px-4 py-2 font-medium">Payment failed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.storeId} data-testid={`subscription-${row.storeSlug}`}>
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      <Link href={`/admin/stores/${row.storeId}`} className="font-medium text-primary underline-offset-4 hover:underline">
                        {row.storeName}
                      </Link>
                    </th>
                    <td className="px-3 py-3 text-foreground">
                      <span className="font-medium">{PLAN_NAMES[effectivePlan(row)]}</span>
                      {row.overridePlan && row.overrideEndsAt && (
                        <span className="block text-xs text-muted-foreground">
                          Override until {dateFormat.format(row.overrideEndsAt)}; Stripe plan {PLAN_NAMES[row.plan as Plan] ?? row.plan}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-foreground">{billingStatusLabel(row.status)}</td>
                    <td className="px-3 py-3 text-foreground">{row.pilot ? "Yes" : "No"}</td>
                    <td className="px-3 py-3 tabular-nums text-foreground">{day(row.trialEndsAt)}</td>
                    <td className="px-3 py-3 tabular-nums text-foreground">{day(row.currentPeriodEnd)}</td>
                    <td className="px-3 py-3 text-foreground">{row.cancelAtPeriodEnd ? "Yes" : "No"}</td>
                    <td className="px-4 py-3 tabular-nums text-foreground">{day(row.paymentFailedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
