import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { listCourierIncidents, listIncidentStores } from "@/lib/admin/courier-incidents";
import {
  INCIDENT_KINDS,
  INCIDENT_PROVIDERS,
  incidentFiltersFromSearchParams,
  type IncidentFilters,
} from "@/lib/admin/courier-incidents-query";
import { formatAge } from "@/lib/admin/format-age";
import { KIND_LABELS, PROVIDER_LABELS, StateLabel, kindsText, providersText, utcTime } from "./labels";

export const metadata = { title: "Courier incidents — Platform Admin" };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const FIELD = `min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground ${FOCUS}`;
const PATH = "/admin/couriers/incidents";

function listHref(filters: IncidentFilters, after?: string): string {
  const params = new URLSearchParams();
  if (filters.storeId) params.set("store", filters.storeId);
  if (filters.provider) params.set("provider", filters.provider);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (after) params.set("after", after);
  const query = params.toString();
  return `${PATH}${query ? `?${query}` : ""}`;
}

/** Courier incidents across stores (#536), computed on load from the database. */
export default async function CourierIncidentsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = incidentFiltersFromSearchParams(await props.searchParams);
  const [{ checkedAt, rows, nextCursor }, stores] = await Promise.all([listCourierIncidents(filters), listIncidentStores()]);
  const now = checkedAt.getTime();
  const filtered = !!(filters.storeId || filters.provider || filters.kind || filters.from || filters.to);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Courier incidents</h1>
      <p className="mt-1 max-w-prose text-muted-foreground">
        Courier orders that failed over, were cancelled or returned, waited past the timeout for a courier, or were
        delivered with no proof. Read from the database when the page opens.
      </p>

      <form method="get" action={PATH} role="search" aria-label="Courier incidents" className="mt-6 grid gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <FilterSelect id="store" label="Store" value={filters.storeId} options={stores.map((s) => ({ value: s.id, label: s.name }))} />
          <FilterSelect id="provider" label="Courier" value={filters.provider} options={INCIDENT_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))} />
          <FilterSelect id="kind" label="What happened" value={filters.kind} options={INCIDENT_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <label htmlFor="from" className="text-sm font-medium text-foreground">From (UTC)</label>
            <input id="from" name="from" type="date" defaultValue={filters.from ?? ""} className={FIELD} />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="to" className="text-sm font-medium text-foreground">To (UTC)</label>
            <input id="to" name="to" type="date" defaultValue={filters.to ?? ""} className={FIELD} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <button type="submit" className={`inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 ${FOCUS}`}>
              Show incidents
            </button>
            {filtered && (
              <Link href={PATH} className={`inline-flex min-h-11 items-center rounded-full px-3 text-sm font-medium text-primary underline-offset-4 hover:underline ${FOCUS}`}>
                Clear filters
              </Link>
            )}
          </div>
        </div>
      </form>

      <p className="mb-3 mt-8 text-sm text-muted-foreground" aria-live="polite" data-testid="incident-count">
        {rows.length === 0
          ? filtered || filters.after ? "No incidents match." : "No courier incidents."
          : `${rows.length} ${rows.length === 1 ? "incident" : "incidents"}${filters.after || nextCursor ? " on this page" : ""}, newest first.`}
      </p>

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted max-sm:sr-only">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium text-muted-foreground">Order</th>
                <th scope="col" className="px-4 py-3 font-medium text-muted-foreground">What happened</th>
                <th scope="col" className="px-4 py-3 font-medium text-muted-foreground">Courier</th>
                <th scope="col" className="px-4 py-3 font-medium text-muted-foreground">Opened</th>
                <th scope="col" className="px-4 py-3 font-medium text-muted-foreground">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.orderId} className="relative hover:bg-muted max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:gap-x-3 max-sm:gap-y-1 max-sm:px-4 max-sm:py-3" data-testid={`incident-row-${row.orderNumber}`}>
                  <td className="px-4 py-3 align-top max-sm:col-start-1 max-sm:p-0">
                    <Link
                      href={`${PATH}/${row.orderId}`}
                      className="font-semibold text-foreground underline-offset-4 after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
                    >
                      #{row.orderNumber}
                    </Link>
                    <span className="block break-words text-muted-foreground">{row.storeName}</span>
                  </td>
                  <td className="px-4 py-3 align-top text-foreground max-sm:col-span-2 max-sm:row-start-2 max-sm:p-0">{kindsText(row.kinds)}</td>
                  <td className="px-4 py-3 align-top text-muted-foreground max-sm:col-span-2 max-sm:row-start-3 max-sm:p-0">{providersText(row.providers)}</td>
                  <td className="px-4 py-3 align-top tabular-nums text-muted-foreground max-sm:col-span-2 max-sm:row-start-4 max-sm:p-0">
                    <span title={utcTime(row.openedAt)}>{formatAge(row.openedAt, now)} ago</span>
                  </td>
                  <td className="px-4 py-3 align-top max-sm:col-start-2 max-sm:row-start-1 max-sm:p-0">
                    <span className="inline-flex items-center gap-1">
                      <StateLabel state={row.state} />
                      <ChevronRight aria-hidden className="size-4 text-muted-foreground sm:hidden" />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(nextCursor || filters.after) && (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3">
          {filters.after ? (
            <Link href={listHref(filters)} className={`inline-flex min-h-11 items-center rounded-full border border-input px-4 text-sm font-medium text-foreground hover:bg-muted ${FOCUS}`}>
              Newest
            </Link>
          ) : <span />}
          {nextCursor ? (
            <Link href={listHref(filters, nextCursor)} className={`inline-flex min-h-11 items-center gap-1 rounded-full border border-input px-4 text-sm font-medium text-foreground hover:bg-muted ${FOCUS}`}>
              Older <ChevronRight aria-hidden className="size-4" />
            </Link>
          ) : <span />}
        </nav>
      )}
    </div>
  );
}

function FilterSelect({ id, label, value, options }: { id: string; label: string; value: string | undefined; options: Array<{ value: string; label: string }> }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      <select id={id} name={id} defaultValue={value ?? ""} className={FIELD}>
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}
