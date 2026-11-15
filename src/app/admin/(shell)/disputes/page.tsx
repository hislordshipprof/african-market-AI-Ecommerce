import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { DISPUTE_QUEUE_LIMIT, listOpenDisputes } from "@/lib/admin/disputes";
import { formatAge } from "@/lib/admin/format-age";
import { disputeReasonLabel, disputeStatusLabel } from "@/lib/disputes/status";

export const metadata = { title: "Disputes — Platform Admin" };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const DUE_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });

function amount(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

function DueCell({ dueBy, now }: { dueBy: Date | null; now: number }) {
  if (!dueBy) return <span className="text-muted-foreground">No deadline</span>;
  const overdue = dueBy.getTime() <= now;
  return (
    <span className="grid">
      <span className="tabular-nums text-foreground">{DUE_DATE.format(dueBy)} UTC</span>
      <span className={`tabular-nums ${overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}>
        {overdue ? `Past due by ${formatAge(dueBy, now)}` : `${formatAge(new Date(now), dueBy.getTime())} left`}
      </span>
    </span>
  );
}

/** Open card disputes across stores (#539), the soonest evidence deadline first. Evidence is answered in Stripe. */
export default async function DisputesPage() {
  const { checkedAt, rows, more } = await listOpenDisputes();
  const now = checkedAt.getTime();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Disputes</h1>
      <p className="mt-1 max-w-prose text-muted-foreground">
        Card payments a customer disputed with their bank, still open. Stripe takes the disputed amount and its fee from
        the platform balance, and the platform covers a lost dispute. Answer each one with evidence in the Stripe
        Dashboard before its deadline.
      </p>

      <p className="mb-3 mt-8 text-sm text-muted-foreground" aria-live="polite" data-testid="dispute-count">
        {rows.length === 0
          ? "No open disputes."
          : `${rows.length} open ${rows.length === 1 ? "dispute" : "disputes"}${more ? ` (the first ${DISPUTE_QUEUE_LIMIT})` : ""}, soonest deadline first.`}
      </p>

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted max-sm:sr-only">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium text-muted-foreground">Evidence due</th>
                <th scope="col" className="px-4 py-3 font-medium text-muted-foreground">Order</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">Amount</th>
                <th scope="col" className="px-4 py-3 font-medium text-muted-foreground">Reason and status</th>
                <th scope="col" className="px-4 py-3 font-medium text-muted-foreground"><span className="sr-only">Stripe</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id} className="max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:gap-x-3 max-sm:gap-y-2 max-sm:px-4 max-sm:py-3" data-testid={`dispute-row-${row.stripeDisputeId}`}>
                  <td className="px-4 py-3 align-top max-sm:col-span-2 max-sm:p-0">
                    <DueCell dueBy={row.evidenceDueBy} now={now} />
                  </td>
                  <td className="px-4 py-3 align-top max-sm:col-start-1 max-sm:p-0">
                    {row.orderId && row.orderNumber !== null ? (
                      <>
                        <Link href={`/admin/orders/search/${row.orderId}`} className={`font-semibold text-foreground underline-offset-4 hover:underline ${FOCUS}`}>
                          #{row.orderNumber}
                        </Link>
                        <span className="block break-words text-muted-foreground">{row.storeName}</span>
                      </>
                    ) : (
                      <>
                        <span className="font-semibold text-foreground">No matching order</span>
                        <span className="block break-all font-mono text-xs text-muted-foreground">{row.stripeDisputeId}</span>
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right align-top font-semibold tabular-nums text-foreground max-sm:col-start-2 max-sm:row-start-2 max-sm:p-0">
                    {amount(row.amountCents, row.currency)}
                  </td>
                  <td className="px-4 py-3 align-top max-sm:col-span-2 max-sm:p-0">
                    <span className="block text-foreground">{disputeReasonLabel(row.reason)}</span>
                    <span className="block text-muted-foreground">{disputeStatusLabel(row.status)}</span>
                  </td>
                  <td className="px-4 py-3 align-top max-sm:col-span-2 max-sm:p-0 sm:text-right">
                    <a
                      href={row.dashboardUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-full px-1 font-medium text-primary underline-offset-4 hover:underline sm:min-h-0 ${FOCUS}`}
                    >
                      Open in Stripe <ExternalLink aria-hidden className="size-4" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
