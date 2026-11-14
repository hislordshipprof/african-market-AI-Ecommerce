"use client";

import { useActionState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { searchOrdersAction } from "@/lib/admin/order-search-action";
import { INITIAL_ORDER_SEARCH, ORDER_FULFILLMENTS, ORDER_SEARCH_PAGE_SIZE, ORDER_STATUSES } from "@/lib/admin/order-search";
import { money } from "@/lib/format";
import { FULFILLMENT_LABELS, placedAt } from "./order-labels";

const FIELD =
  "min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:text-sm";
const LABEL = "mb-1 block text-sm font-medium text-foreground";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function OrderSearch({ stores }: { stores: Array<{ id: string; name: string }> }) {
  const [state, search, pending] = useActionState(searchOrdersAction, INITIAL_ORDER_SEARCH);
  const values = state.values;
  const first = (state.page - 1) * ORDER_SEARCH_PAGE_SIZE + 1;

  return (
    <>
      {/* Keyed on the result so the fields come back as searched after React resets the form. */}
      <form key={`${state.page}-${JSON.stringify(values)}-${state.error}`} action={search} className="mt-6 rounded-xl border border-border bg-card p-4 sm:p-5" aria-describedby="search-error">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <label htmlFor="storeId" className={LABEL}>Store</label>
            <select id="storeId" name="storeId" defaultValue={values.storeId ?? ""} className={FIELD}>
              <option value="">All stores</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>{store.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="number" className={LABEL}>Order number</label>
            <input id="number" name="number" inputMode="numeric" autoComplete="off" defaultValue={values.number ?? ""} className={FIELD} aria-describedby="number-hint" />
            <p id="number-hint" className="mt-1 text-xs text-muted-foreground">Needs a store.</p>
          </div>
          <div>
            <label htmlFor="status" className={LABEL}>Status</label>
            <select id="status" name="status" defaultValue={values.status ?? ""} className={FIELD}>
              <option value="">Any status</option>
              {ORDER_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="email" className={LABEL}>Customer email</label>
            <input id="email" name="email" type="email" autoComplete="off" spellCheck={false} defaultValue={values.email ?? ""} className={FIELD} />
          </div>
          <div>
            <label htmlFor="phone" className={LABEL}>Customer phone</label>
            <input id="phone" name="phone" type="tel" autoComplete="off" defaultValue={values.phone ?? ""} className={FIELD} />
          </div>
          <div>
            <label htmlFor="fulfillment" className={LABEL}>Fulfillment</label>
            <select id="fulfillment" name="fulfillment" defaultValue={values.fulfillment ?? ""} className={FIELD}>
              <option value="">Any</option>
              {ORDER_FULFILLMENTS.map((fulfillment) => (
                <option key={fulfillment} value={fulfillment}>{FULFILLMENT_LABELS[fulfillment]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="from" className={LABEL}>Placed from</label>
            <input id="from" name="from" type="date" defaultValue={values.from ?? ""} className={FIELD} aria-describedby="dates-hint" />
          </div>
          <div>
            <label htmlFor="to" className={LABEL}>Placed to</label>
            <input id="to" name="to" type="date" defaultValue={values.to ?? ""} className={FIELD} aria-describedby="dates-hint" />
          </div>
          <p id="dates-hint" className="self-end text-xs text-muted-foreground sm:col-span-2 sm:pb-3">
            Dates are store days, in each store&apos;s own time zone.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className={`inline-flex min-h-11 items-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 ${FOCUS}`}
          >
            {pending ? "Searching…" : "Search"}
          </button>
          {state.nextCursor && (
            <button
              type="submit"
              name="cursor"
              value={state.nextCursor}
              disabled={pending}
              className={`inline-flex min-h-11 items-center rounded-full border border-input px-5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60 ${FOCUS}`}
            >
              Next {ORDER_SEARCH_PAGE_SIZE} orders
            </button>
          )}
        </div>
        <p id="search-error" role="alert" className="mt-3 text-sm text-destructive empty:hidden">{state.error}</p>
      </form>

      {state.rows && (
        <section aria-labelledby="results-heading" className="mt-8">
          <h2 id="results-heading" className="mb-3 text-sm font-semibold text-muted-foreground" aria-live="polite">
            {state.rows.length === 0
              ? "No orders match."
              : `Orders ${first}–${first + state.rows.length - 1}${state.nextCursor ? ", more on the next page" : ""}`}
          </h2>
          {state.rows.length > 0 && (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card" data-testid="order-results">
              {state.rows.map((row) => (
                <li key={row.id}>
                  <Link
                    href={`/admin/orders/search/${row.id}`}
                    data-testid={`order-result-${row.number}`}
                    className={`group flex min-h-16 items-center gap-4 px-4 py-3 hover:bg-muted sm:px-5 ${FOCUS}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">
                        #{row.number} · {row.storeName}
                      </span>
                      <span className="mt-0.5 block text-sm text-muted-foreground">
                        <span className="font-mono text-xs text-foreground">{row.status}</span>
                        {" · "}
                        {FULFILLMENT_LABELS[row.fulfillment] ?? row.fulfillment}
                        {" · "}
                        <span className="whitespace-nowrap">{placedAt(row.createdAt, row.storeTimezone)}</span>
                      </span>
                    </span>
                    <span className="shrink-0 text-right tabular-nums text-foreground">
                      {money(row.capturedAmountCents ?? row.totalAuthorizedCents)}
                      <span className="block text-xs text-muted-foreground">{row.capturedAmountCents === null ? "held" : "captured"}</span>
                    </span>
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

