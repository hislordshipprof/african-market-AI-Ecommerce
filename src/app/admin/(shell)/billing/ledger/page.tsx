import Link from "next/link";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { requirePlatformAdmin } from "@/lib/admin/session";
import {
  AMOUNT_COLUMNS,
  ROW_LABELS,
  ledgerPage,
  ordersLabel,
  parseLedgerMonth,
  shiftMonth,
  utcDate,
  type LedgerAmounts,
} from "@/lib/admin/fee-ledger";
import { platformFeeLedger } from "@/lib/admin/fee-ledger-query";
import { money } from "@/lib/format";

export const metadata = { title: "Fee ledger — Platform Admin" };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const TH = "px-3 py-3 font-medium text-muted-foreground";
const NUM = "px-3 py-3 text-right tabular-nums whitespace-nowrap";

const utcDay = (at: Date) => at.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function AmountCells({ values }: { values: LedgerAmounts }) {
  return AMOUNT_COLUMNS.map(([key]) => (
    <td key={key} className={`${NUM} ${values[key] < 0 ? "text-muted-foreground" : "text-foreground"}`}>
      {money(values[key])}
    </td>
  ));
}

function AmountHeads() {
  return AMOUNT_COLUMNS.map(([key, label]) => (
    <th key={key} scope="col" className={`${TH} text-right`}>
      {label}
    </th>
  ));
}

export default async function FeeLedgerPage({ searchParams }: { searchParams: Promise<{ month?: string; page?: string }> }) {
  const [, params] = await Promise.all([requirePlatformAdmin(), searchParams]);
  const monthKey = parseLedgerMonth(params.month, new Date());
  const ledger = await platformFeeLedger(monthKey);
  const page = ledgerPage(ledger.rows.length, params.page);
  const rows = ledger.rows.slice(page.from, page.to);
  const href = (month: string, pageNumber = 1) =>
    `/admin/billing/ledger?month=${month}${pageNumber > 1 ? `&page=${pageNumber}` : ""}`;
  const lastSecond = new Date(ledger.month.endsAt.getTime() - 1000);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Fee ledger</h1>
      <p className="mt-1 max-w-2xl text-muted-foreground">
        What the platform keeps on each captured order, and the fee it returns on refunds, from our order records.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Month" className="flex items-center gap-1">
          <Link
            href={href(shiftMonth(monthKey, -1))}
            aria-label="Previous month"
            className={`inline-flex size-10 items-center justify-center rounded-md border border-border bg-card text-foreground hover:bg-muted ${FOCUS}`}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Link>
          <h2 className="min-w-40 px-2 text-center text-lg font-semibold text-foreground" data-testid="ledger-month">
            {ledger.month.label}
          </h2>
          <Link
            href={href(shiftMonth(monthKey, 1))}
            aria-label="Next month"
            className={`inline-flex size-10 items-center justify-center rounded-md border border-border bg-card text-foreground hover:bg-muted ${FOCUS}`}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        </nav>
        <a
          href={`/api/admin/billing/ledger/export?month=${monthKey}`}
          download
          className={`inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 ${FOCUS}`}
        >
          <Download className="size-4" aria-hidden />
          Download CSV
        </a>
      </div>
      <p className="mt-2 text-sm text-muted-foreground" data-testid="ledger-bounds">
        <time dateTime={ledger.month.startsAt.toISOString()}>{utcDay(ledger.month.startsAt)} 00:00</time> to{" "}
        <time dateTime={lastSecond.toISOString()}>{utcDay(lastSecond)} 23:59:59</time> UTC. An order counts in the month
        it was captured; a refund in the month it succeeded.
      </p>

      <h2 className="mb-3 mt-8 text-sm font-semibold text-muted-foreground">Totals by store</h2>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[64rem] text-left text-sm" data-testid="ledger-store-totals">
          <thead className="border-b border-border bg-muted">
            <tr>
              <th scope="col" className={TH}>Store</th>
              <th scope="col" className={`${TH} text-right`}>Orders</th>
              <AmountHeads />
            </tr>
          </thead>
          <tbody>
            {ledger.stores.length === 0 ? (
              <tr>
                <td colSpan={2 + AMOUNT_COLUMNS.length} className="px-3 py-8 text-center text-muted-foreground">
                  No captured orders or fee refunds in {ledger.month.label}.
                </td>
              </tr>
            ) : (
              ledger.stores.map((store) => (
                <tr key={store.storeId} className="border-b border-border last:border-0">
                  <th scope="row" className="px-3 py-3 font-medium text-foreground">{store.storeName}</th>
                  <td className={NUM}>{store.orders}</td>
                  <AmountCells values={store} />
                </tr>
              ))
            )}
          </tbody>
          <tfoot className="border-t border-border bg-muted font-semibold">
            <tr data-testid="ledger-month-total">
              <th scope="row" className="px-3 py-3 text-foreground">All stores</th>
              <td className={NUM}>{ledger.total.orders}</td>
              <AmountCells values={ledger.total} />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mb-3 mt-8 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Orders and refunds</h2>
        {ledger.rows.length > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="ledger-range">
            Rows {page.from + 1}–{page.to} of {ledger.rows.length} ({ordersLabel(ledger.total.orders)})
          </p>
        )}
      </div>
      {ledger.rows.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
          Nothing was captured or refunded this month.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[72rem] text-left text-sm" data-testid="ledger-rows">
            <thead className="border-b border-border bg-muted">
              <tr>
                <th scope="col" className={TH}>Date (UTC)</th>
                <th scope="col" className={TH}>Store</th>
                <th scope="col" className={TH}>Order</th>
                <th scope="col" className={TH}>Row</th>
                <AmountHeads />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.kind}-${row.id}`} className="border-b border-border last:border-0">
                  <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{utcDate(row.at)}</td>
                  <td className="px-3 py-3 text-foreground">{row.storeName}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-foreground">#{row.orderNumber}</td>
                  <td className="px-3 py-3 text-foreground">{ROW_LABELS[row.kind]}</td>
                  <AmountCells values={row} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.count > 1 && (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3 text-sm">
          {page.number > 1 ? (
            <Link href={href(monthKey, page.number - 1)} className={`rounded-md px-3 py-2 font-medium text-foreground underline underline-offset-4 ${FOCUS}`}>
              Previous rows
            </Link>
          ) : <span />}
          <span className="text-muted-foreground">Page {page.number} of {page.count}</span>
          {page.number < page.count ? (
            <Link href={href(monthKey, page.number + 1)} className={`rounded-md px-3 py-2 font-medium text-foreground underline underline-offset-4 ${FOCUS}`}>
              Next rows
            </Link>
          ) : <span />}
        </nav>
      )}
    </div>
  );
}
