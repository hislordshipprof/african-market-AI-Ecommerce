import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, Store } from "lucide-react";
import { requireStoreOwner } from "@/lib/store-admin/session";
import { storePayoutDetail } from "@/lib/payouts/service";
import type { PayoutOrderRow } from "@/lib/payouts/breakdown";
import { money } from "@/lib/format";
import { Notice, StripeDashboardButton, arrivalDate, payoutStatus } from "../payout-parts";

const COLUMNS: Array<{ key: keyof PayoutOrderRow; label: string; minus?: boolean }> = [
  { key: "goodsCents", label: "Goods" },
  { key: "tipCents", label: "Tip" },
  { key: "taxCents", label: "Tax" },
  { key: "cardFeeCents", label: "Card fee", minus: true },
  { key: "refundsCents", label: "Refunds", minus: true },
];

const amount = (cents: number, minus?: boolean) => (minus && cents > 0 ? `−${money(cents)}` : money(cents));

export default async function PayoutDetailPage({ params }: { params: Promise<{ payoutId: string }> }) {
  const [{ store }, { payoutId }] = await Promise.all([requireStoreOwner(), params]);
  const detail = await storePayoutDetail(store, payoutId);
  if (!detail.ok && detail.notFound) notFound();
  const slug = encodeURIComponent(store.slug);

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link href={`/store-admin?store=${slug}`} className="flex min-h-11 items-center gap-2 rounded-lg bg-primary px-3 text-primary-foreground">
            <Store className="size-5" aria-hidden />
            <span className="text-sm font-semibold">Dashboard</span>
          </Link>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-foreground">{store.name}</p>
            <p className="text-xs text-muted-foreground">Payouts</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        <Link
          href={`/store-admin/payouts?store=${slug}`}
          className="mb-6 inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          All payouts
        </Link>

        {!detail.ok ? (
          <Notice>{detail.error}</Notice>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="font-heading text-2xl font-bold tabular-nums text-foreground">
                  Payout of {money(detail.payout.amountCents)}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {payoutStatus(detail.payout.status)} · arrives {arrivalDate(detail.payout.arrivalDate)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href={`/store-admin/payouts/${encodeURIComponent(payoutId)}/csv?store=${slug}`}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <Download className="size-4" aria-hidden />
                  CSV
                </a>
                <StripeDashboardButton slug={store.slug} />
              </div>
            </div>

            <p className="mb-4 max-w-prose text-sm text-muted-foreground">
              Net to store is goods, tip and tax, less your card fee and refunds. Goods include your own delivery fee.
              Stripe&apos;s reconciliation report in your Stripe dashboard shows every transaction.
            </p>

            {detail.breakdown.rows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
                No orders from this store are in this payout.
              </p>
            ) : (
              <>
                <table className="hidden w-full text-sm md:table" data-testid="payout-orders">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th scope="col" className="py-2 pr-3 font-medium">Order</th>
                      {COLUMNS.map((c) => (
                        <th key={c.key} scope="col" className="px-3 py-2 text-right font-medium">{c.label}</th>
                      ))}
                      <th scope="col" className="py-2 pl-3 text-right font-medium">Net to store</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {detail.breakdown.rows.map((r) => (
                      <tr key={r.orderId}>
                        <th scope="row" className="py-2 pr-3 text-left font-medium text-foreground">
                          #{r.number}
                          {!r.paidInPayout && <span className="ml-2 text-xs font-normal text-muted-foreground">refund only</span>}
                        </th>
                        {COLUMNS.map((c) => (
                          <td key={c.key} className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {amount(r[c.key] as number, c.minus)}
                          </td>
                        ))}
                        <td className="py-2 pl-3 text-right font-medium tabular-nums text-foreground">{money(r.netCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {detail.breakdown.otherCents !== 0 && (
                      <tr className="border-t border-border">
                        <th scope="row" colSpan={6} className="py-2 pr-3 text-left font-normal text-muted-foreground">Other Stripe activity</th>
                        <td className="py-2 pl-3 text-right tabular-nums text-foreground">{money(detail.breakdown.otherCents)}</td>
                      </tr>
                    )}
                    <tr className="border-t-2 border-border">
                      <th scope="row" colSpan={6} className="py-2 pr-3 text-left font-semibold text-foreground">Payout total</th>
                      <td className="py-2 pl-3 text-right font-semibold tabular-nums text-foreground">{money(detail.breakdown.totalCents)}</td>
                    </tr>
                  </tfoot>
                </table>

                <ul className="divide-y divide-border rounded-xl border border-border bg-card md:hidden">
                  {detail.breakdown.rows.map((r) => (
                    <li key={r.orderId} className="px-4 py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-semibold text-foreground">
                          #{r.number}
                          {!r.paidInPayout && <span className="ml-2 text-xs font-normal text-muted-foreground">refund only</span>}
                        </span>
                        <span className="text-sm font-semibold tabular-nums text-foreground">{money(r.netCents)}</span>
                      </div>
                      <dl className="mt-1 grid grid-cols-2 gap-x-4 text-xs">
                        {COLUMNS.map((c) => (
                          <div key={c.key} className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">{c.label}</dt>
                            <dd className="tabular-nums text-foreground">{amount(r[c.key] as number, c.minus)}</dd>
                          </div>
                        ))}
                      </dl>
                    </li>
                  ))}
                  {detail.breakdown.otherCents !== 0 && (
                    <li className="flex justify-between px-4 py-3 text-sm">
                      <span className="text-muted-foreground">Other Stripe activity</span>
                      <span className="tabular-nums text-foreground">{money(detail.breakdown.otherCents)}</span>
                    </li>
                  )}
                  <li className="flex justify-between px-4 py-3 text-sm font-semibold text-foreground">
                    <span>Payout total</span>
                    <span className="tabular-nums">{money(detail.breakdown.totalCents)}</span>
                  </li>
                </ul>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
