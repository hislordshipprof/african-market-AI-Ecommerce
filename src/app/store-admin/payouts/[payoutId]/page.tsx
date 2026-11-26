import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { requireStoreOwner } from "@/lib/store-admin/session";
import { storePayoutDetail } from "@/lib/payouts/service";
import type { PayoutOrderRow } from "@/lib/payouts/breakdown";
import { money } from "@/lib/format";
import { PageHeader } from "@/app/store-admin/shell/page-header";
import { Notice, StripeDashboardButton, arrivalDate, payoutStatus } from "../payout-parts";

const COLUMNS: Array<{ key: keyof PayoutOrderRow; label: string; minus?: boolean }> = [
  { key: "goodsCents", label: "Goods" },
  { key: "discountCents", label: "Promo discount", minus: true },
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
    <>
      <PageHeader
        title={detail.ok ? `Payout of ${money(detail.payout.amountCents)}` : "Payout"}
        description={detail.ok ? `${payoutStatus(detail.payout.status)} · arrives ${arrivalDate(detail.payout.arrivalDate)}` : undefined}
        parent={{ href: `/store-admin/payouts?store=${slug}`, label: "Payouts" }}
        actions={
          detail.ok ? (
            <>
              <a
                href={`/store-admin/payouts/${encodeURIComponent(payoutId)}/csv?store=${slug}`}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <Download className="size-4" aria-hidden />
                CSV
              </a>
              <StripeDashboardButton slug={store.slug} />
            </>
          ) : undefined
        }
      />

      <div>
        {!detail.ok ? (
          <Notice>{detail.error}</Notice>
        ) : (
          <>
            <p className="mb-4 max-w-prose text-sm text-muted-foreground">
              Net to store is goods, tip and tax, less promo discounts your store funds, your card fee and refunds. Goods include your own delivery fee.
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
                        <th scope="row" colSpan={7} className="py-2 pr-3 text-left font-normal text-muted-foreground">Other Stripe activity</th>
                        <td className="py-2 pl-3 text-right tabular-nums text-foreground">{money(detail.breakdown.otherCents)}</td>
                      </tr>
                    )}
                    <tr className="border-t-2 border-border">
                      <th scope="row" colSpan={7} className="py-2 pr-3 text-left font-semibold text-foreground">Payout total</th>
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
      </div>
    </>
  );
}
