import { RUNNING_OUT_DAYS, estimateText, type MovementRow, type MovementTotals } from "@/lib/copilot/inventory-report";

const SHOWN = 25;
const dateLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function estimateLine(row: MovementRow): string {
  const text = estimateText(row.estimate);
  if (row.estimate.kind !== "estimate") return text;
  return `${text}, ${dateLabel.format(new Date(`${row.estimate.outDate}T00:00:00Z`))}`;
}

function movementLine(row: MovementRow): string {
  const parts = [`Online ${row.online7} (week before ${row.onlinePrior7})`, `Counter ${row.counter7}`];
  if (row.restocked7 > 0) parts.push(`Restocked ${row.restocked7}`);
  if (row.short7 > 0) parts.push(`Short ${row.short7}`);
  return parts.join(" · ");
}

function Row({ row }: { row: MovementRow }) {
  const soon = row.estimate.kind === "estimate" && row.estimate.daysLeft <= RUNNING_OUT_DAYS;
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-base font-semibold text-foreground">{row.name}</p>
        <p className="shrink-0 text-sm text-muted-foreground tabular-nums">
          {row.qty === null ? "Status only" : `${row.qty} on hand`}
        </p>
      </div>
      <p className="text-sm text-muted-foreground tabular-nums">{movementLine(row)}</p>
      <p className={`text-sm tabular-nums ${soon ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
        {estimateLine(row)}
      </p>
    </li>
  );
}

export function StockMovement({ rows, totals }: { rows: MovementRow[]; totals: MovementTotals }) {
  const rest = rows.slice(SHOWN);
  return (
    <section aria-labelledby="stock-movement-title" className="mt-8 flex flex-col gap-3">
      <div>
        <h2 id="stock-movement-title" className="font-display text-[1.375rem] leading-tight font-bold text-balance text-foreground">
          Stock movement
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Last 7 days. Sales are online orders plus the counter sales you report. Counter sales nobody reports are not seen,
          so an estimate may be late. Items with fewer than 3 sales in 14 days get no estimate.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-4 text-base text-muted-foreground">No active listings yet.</p>
      ) : (
        <>
          <p className="text-sm text-foreground tabular-nums">
            {`Online ${totals.online} (week before ${totals.onlinePrior}) · Counter ${totals.counter} · Restocked ${totals.restocked} · Short ${totals.short}`}
          </p>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {rows.slice(0, SHOWN).map((row) => <Row key={row.listingId} row={row} />)}
          </ul>
          {rest.length > 0 ? (
            <details className="rounded-xl border border-border bg-card">
              <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-semibold text-foreground">
                {`Show ${rest.length} more`}
              </summary>
              <ul className="divide-y divide-border border-t border-border">
                {rest.map((row) => <Row key={row.listingId} row={row} />)}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}
