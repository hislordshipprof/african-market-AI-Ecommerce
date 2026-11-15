import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { money } from "@/lib/format";
import { DASHBOARD_ERROR, storePayouts } from "@/lib/payouts/service";
import { Notice, StripeDashboardButton, arrivalDate, payoutStatus } from "./payout-parts";

/** The store's last payouts, each opening its orders (#548). */
export async function PayoutList({
  store,
  dashboardFailed,
}: {
  store: { id: string; slug: string; stripeAccountId: string | null };
  dashboardFailed: boolean;
}) {
  if (!store.stripeAccountId) return null;
  const result = await storePayouts(store);
  return (
    <section aria-labelledby="payouts-title" className="mt-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="payouts-title" className="text-lg font-semibold text-foreground">Recent payouts</h2>
          <p className="text-sm text-muted-foreground">Your last 12 payouts. Open one to see the orders in it.</p>
        </div>
        <StripeDashboardButton slug={store.slug} />
      </div>
      {dashboardFailed && <div className="mb-4"><Notice>{DASHBOARD_ERROR}</Notice></div>}
      {!result.ok ? (
        <Notice>{result.error}</Notice>
      ) : result.payouts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
          No payouts yet. Stripe sends your first payout a few days after your first order is paid.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card" data-testid="payout-list">
          {result.payouts.map((p) => (
            <li key={p.id}>
              <Link
                href={`/store-admin/payouts/${encodeURIComponent(p.id)}?store=${encodeURIComponent(store.slug)}`}
                className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{arrivalDate(p.arrivalDate)}</span>
                  <span className={`block text-xs ${p.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                    {payoutStatus(p.status)}
                  </span>
                </span>
                <span className="text-sm font-semibold tabular-nums text-foreground">{money(p.amountCents)}</span>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
