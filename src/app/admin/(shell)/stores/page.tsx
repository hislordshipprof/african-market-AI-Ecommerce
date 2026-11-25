import Link from "next/link";
import { Ban, ChevronRight, CircleAlert, Plus } from "lucide-react";
import { listStores } from "@/lib/admin/actions";
import { listMetros } from "@/lib/admin/metros";
import { platformTotals } from "@/lib/admin/platform-totals";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { filterStores, parseStoreFilters, STORE_VIEWS, storeViewCounts } from "@/lib/admin/store-views";
import { addDays, storeToday } from "@/lib/analytics/range";
import { BILLING_STATUSES, billingStatusLabel, PLAN_NAMES } from "@/lib/billing/plan";
import { StoreFilters } from "./filters";
import { SuspendButton } from "./suspend-button";

export const metadata = { title: "Stores — Platform Admin" };

/** The platform's day, as on Home: each store's sales are read in its own zone. */
const PLATFORM_ZONE = "America/New_York";
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default async function StoreListPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePlatformAdmin();
  const now = new Date();
  const today = storeToday(PLATFORM_ZONE, now);
  const [stores, metros, sales] = await Promise.all([
    listStores(),
    listMetros(),
    platformTotals(addDays(today, -6), today, now).catch((error: unknown) => {
      console.error("[admin stores] sales failed", error);
      return null;
    }),
  ]);
  const filters = parseStoreFilters(await searchParams, metros.map((metro) => metro.id));
  const metroName = new Map(metros.map((metro) => [metro.id, metro.name]));
  const sold = new Map(sales?.ok ? sales.stores.map((row) => [row.storeId, row]) : []);
  const counts = storeViewCounts(stores);
  const shown = filterStores(stores, filters);
  const failed = stores.filter((store) => store.subscription?.paymentFailedAt);
  const metroCount = new Set(stores.map((store) => store.metroId).filter(Boolean)).size;
  const rows = shown.map((store) => ({
    ...store,
    metro: store.metroId ? metroName.get(store.metroId) ?? null : null,
    sales: sales?.ok ? sold.get(store.id) ?? { orders: 0, goodsCents: 0 } : null,
  }));

  const viewHref = (view: string) => {
    const params = new URLSearchParams();
    if (view !== "all") params.set("view", view);
    for (const name of ["q", "metro", "plan", "billing", "pilot"] as const) if (filters[name]) params.set(name, filters[name]);
    const query = params.toString();
    return query ? `/admin/stores?${query}` : "/admin/stores";
  };

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Stores</h1>
          <p className="text-muted-foreground">
            {stores.length} {stores.length === 1 ? "store" : "stores"} in {metroCount} {metroCount === 1 ? "metro" : "metros"}
          </p>
        </div>
        <Link
          href="/admin/stores/new"
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
        >
          <Plus aria-hidden className="size-4" />
          Create store
        </Link>
      </div>

      {failed.length > 0 && (
        <div role="alert" className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">Subscription payment failed for {failed.map((store) => store.name).join(", ")}.</p>
          <p>Their storefronts stay up. Stripe retries the card; suspend a store only by decision.</p>
        </div>
      )}

      <nav aria-label="Saved views" className="mt-5 flex gap-1 overflow-x-auto overscroll-x-contain border-b border-border text-sm [scrollbar-width:none]">
        {STORE_VIEWS.map((view) => {
          const current = filters.view === view.value;
          return (
            <Link
              key={view.value}
              href={viewHref(view.value)}
              aria-current={current ? "page" : undefined}
              className={`-mb-px flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring ${
                current ? "border-foreground font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {view.label} <span className="tabular-nums text-muted-foreground">{counts[view.value]}</span>
            </Link>
          );
        })}
      </nav>

      <StoreFilters
        filters={filters}
        options={{
          metro: [...metros.map((metro) => ({ value: metro.id, label: metro.name })), { value: "none", label: "No metro" }],
          plan: Object.entries(PLAN_NAMES).map(([value, label]) => ({ value, label })),
          billing: BILLING_STATUSES.map((value) => ({ value, label: billingStatusLabel(value) })),
          pilot: [{ value: "yes", label: "Pilot" }, { value: "no", label: "Not pilot" }],
        }}
      />

      {stores.length === 0 ? (
        <div className="mt-4 rounded-xl border border-border bg-card p-8 text-center">
          <p className="text-muted-foreground">
            No stores yet.{" "}
            <Link href="/admin/stores/new" className="text-primary underline">
              Create the first one
            </Link>
            .
          </p>
        </div>
      ) : rows.length === 0 ? (
        <p role="status" className="mt-4 rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
          No store matches these filters.
        </p>
      ) : (
        <>
          <div className="mt-4 hidden overflow-hidden rounded-xl border border-border bg-card md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] whitespace-nowrap text-left text-sm tabular-nums">
                <thead className="border-b border-border bg-muted text-[13px] text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 pl-4 font-medium">Store</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Metro</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Plan</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Billing</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">GMV, 7 days</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Orders</th>
                    <th scope="col" className="px-3 py-2.5 font-medium"><span className="sr-only">Actions</span></th>
                    <th scope="col" className="w-8"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((store) => (
                    <tr key={store.id} className="relative hover:bg-muted has-[a:focus-visible]:outline-2 has-[a:focus-visible]:-outline-offset-2 has-[a:focus-visible]:outline-ring">
                      <td className="max-w-[280px] px-3 py-2 pl-4">
                        <Link href={`/admin/stores/${store.id}`} className="block truncate font-semibold text-foreground after:absolute after:inset-0 focus-visible:outline-none">
                          {store.name}
                        </Link>
                        <span className="block truncate text-[13px] text-muted-foreground" translate="no">{store.slug}</span>
                      </td>
                      <td className="px-3 py-2 text-foreground">{store.metro ?? <span className="text-muted-foreground">None</span>}</td>
                      <td className="px-3 py-2"><StatusBadge status={store.status} /></td>
                      <td className="px-3 py-2 text-foreground">
                        {PLAN_NAMES[store.plan]}
                        {store.subscription?.pilot && <span className="ml-1.5 rounded-full bg-secondary px-1.5 text-xs font-semibold text-foreground">Pilot</span>}
                      </td>
                      <td className="px-3 py-2"><Billing store={store} /></td>
                      <td className="px-3 py-2 text-right text-foreground">
                        {!store.sales ? <span className="text-muted-foreground">—</span> : store.sales.goodsCents > 0 ? usd.format(Math.round(store.sales.goodsCents / 100)) : <span className="text-muted-foreground">None</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {store.sales ? <span className={store.sales.orders ? "text-foreground" : "text-muted-foreground"}>{store.sales.orders}</span> : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="relative z-10 px-3 py-2">
                        <SuspendButton storeId={store.id} currentStatus={store.status} />
                      </td>
                      <td className="px-2 py-2 text-muted-foreground"><ChevronRight aria-hidden className="size-4" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-border px-4 py-2.5 text-sm tabular-nums text-muted-foreground">
              {rows.length} {rows.length === 1 ? "result" : "results"}
              {!sales?.ok && " · Sales couldn't be loaded"}
            </p>
          </div>

          <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card md:hidden">
            {rows.map((store) => (
              <li key={store.id} className="relative flex items-start gap-3 px-4 py-3 hover:bg-muted has-[a:focus-visible]:outline-2 has-[a:focus-visible]:-outline-offset-2 has-[a:focus-visible]:outline-ring">
                <span className="min-w-0 flex-1">
                  <Link href={`/admin/stores/${store.id}`} className="block truncate font-semibold text-foreground after:absolute after:inset-0 focus-visible:outline-none">
                    {store.name}
                  </Link>
                  <span className="mt-0.5 block text-[13px] text-muted-foreground">
                    {[store.metro, PLAN_NAMES[store.plan], store.subscription?.pilot ? "pilot" : null].filter(Boolean).join(", ")}
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px]">
                    <StatusBadge status={store.status} />
                    {store.subscription?.paymentFailedAt && <Billing store={store} />}
                    <span className="relative z-10"><SuspendButton storeId={store.id} currentStatus={store.status} /></span>
                  </span>
                </span>
                {store.sales && (
                  <span className="shrink-0 text-right tabular-nums">
                    <span className="block font-semibold text-foreground">{store.sales.goodsCents > 0 ? usd.format(Math.round(store.sales.goodsCents / 100)) : "None"}</span>
                    <span className="block text-[13px] text-muted-foreground">{store.sales.orders} {store.sales.orders === 1 ? "order" : "orders"}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "suspended") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[13px] font-medium text-destructive">
        <Ban aria-hidden className="size-3.5" />
        Suspended
      </span>
    );
  }
  if (status === "setup") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[13px] font-medium text-foreground">
        <span aria-hidden className="size-1.5 rounded-full border border-input" />
        In setup
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-[13px] font-medium text-foreground">
      <span aria-hidden className="size-1.5 rounded-full bg-primary" />
      Live
    </span>
  );
}

function Billing({ store }: { store: { subscription: { status: string; paymentFailedAt: Date | null } | null } }) {
  if (store.subscription?.paymentFailedAt) {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-destructive">
        <CircleAlert aria-hidden className="size-3.5" />
        Payment failed
      </span>
    );
  }
  return <span className="text-muted-foreground">{billingStatusLabel(store.subscription?.status ?? "none")}</span>;
}
