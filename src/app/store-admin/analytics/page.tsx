import Link from "next/link";
import { Download, Store } from "lucide-react";
import { requireStoreOwner } from "@/lib/store-admin/session";
import { PLAN_NAMES, planAllows, storePlan } from "@/lib/billing/plan";
import { assistantChatUsage } from "@/lib/billing/assistant-chats";
import { PlanLocked } from "@/components/store-admin/plan-locked";
import { money } from "@/lib/format";
import { RANGE_PRESETS, resolveRange, storeToday, type AnalyticsRange } from "@/lib/analytics/range";
import { CANCEL_REASON_LABELS, storeAnalytics, type SalesDay } from "@/lib/analytics/queries";
import { FULFILLMENT_LABELS, type AnalyticsView } from "@/lib/analytics/csv";

type Search = { store?: string; range?: string; from?: string; to?: string };

const count = (n: number) => n.toLocaleString("en-US");
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part * 100) / whole) : 0);
const dayLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtDay = (day: string) => dayLabel.format(new Date(`${day}T00:00:00Z`));

function rangeQuery(range: AnalyticsRange): string {
  return range.preset === "custom" ? `range=custom&from=${range.from}&to=${range.to}` : `range=${range.preset}`;
}

function Header({ slug, name, subtitle }: { slug: string; name: string; subtitle: string }) {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
        <Link
          href={`/store-admin?store=${slug}`}
          className="flex min-h-11 items-center gap-2 rounded-lg bg-primary px-3 text-primary-foreground"
        >
          <Store className="size-5" aria-hidden />
          <span className="text-sm font-semibold">Dashboard</span>
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold text-foreground">{name}</h1>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
    </header>
  );
}

function Section({
  id,
  title,
  note,
  csvHref,
  children,
}: {
  id: AnalyticsView;
  title: string;
  note?: string;
  csvHref: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-28 border-t border-border pt-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={`${id}-title`} className="font-heading text-xl font-bold text-foreground">{title}</h2>
          {note && <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">{note}</p>}
        </div>
        <a
          href={csvHref}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Download className="size-4" aria-hidden />
          CSV<span className="sr-only"> of {title.toLowerCase()}</span>
        </a>
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{value}</dd>
      {detail && <dd className="text-xs text-muted-foreground">{detail}</dd>}
    </div>
  );
}

/** Two-part bar with a text legend, so the split never relies on colour alone. */
function SplitBar({ label, parts }: { label: string; parts: Array<{ name: string; value: number }> }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  const tones = ["bg-primary", "bg-primary/35", "bg-muted-foreground/40"];
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label}: ${parts.map((p) => `${p.name} ${count(p.value)}`).join(", ")}`}>
        {total > 0 && parts.map((p, i) => <div key={p.name} className={tones[i]} style={{ width: `${(p.value / total) * 100}%` }} />)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {parts.map((p, i) => (
          <li key={p.name} className="flex items-center gap-1.5 text-foreground">
            <span className={`size-2.5 rounded-full ${tones[i]}`} aria-hidden />
            {p.name} <span className="tabular-nums text-muted-foreground">{count(p.value)} · {pct(p.value, total)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DayChart({ days }: { days: SalesDay[] }) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.goodsCents, d.netCents)));
  const dense = days.length > 31;
  return (
    <figure>
      <div className="flex h-40 items-end gap-px sm:gap-0.5" aria-hidden>
        {days.map((d) => (
          <div key={d.day} className="relative h-full flex-1" title={`${fmtDay(d.day)}: goods ${money(d.goodsCents)}, net ${money(d.netCents)}, ${d.orders} orders`}>
            <div className="absolute inset-x-0 bottom-0 rounded-t-sm bg-primary/25" style={{ height: `${(d.goodsCents / max) * 100}%` }} />
            <div className="absolute inset-x-[22%] bottom-0 rounded-t-sm bg-primary" style={{ height: `${(Math.max(0, d.netCents) / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs tabular-nums text-muted-foreground" aria-hidden>
        <span>{fmtDay(days[0].day)}</span>
        {!dense && days.length > 2 && <span>{fmtDay(days[Math.floor(days.length / 2)].day)}</span>}
        <span>{fmtDay(days[days.length - 1].day)}</span>
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 text-sm text-foreground">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-primary/25" aria-hidden />Goods revenue</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-primary" aria-hidden />Net to store</span>
      </figcaption>
    </figure>
  );
}

function RangePicker({ slug, range, today }: { slug: string; range: AnalyticsRange; today: string }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <nav aria-label="Date range" className="flex rounded-full border border-border bg-card p-1">
        {RANGE_PRESETS.map((days) => {
          const active = range.preset === days;
          return (
            <Link
              key={days}
              href={`/store-admin/analytics?store=${slug}&range=${days}`}
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-9 items-center rounded-full px-3 text-sm font-medium tabular-nums ${active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted"}`}
            >
              {days} days
            </Link>
          );
        })}
      </nav>
      <form method="get" action="/store-admin/analytics" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="store" value={slug} />
        <input type="hidden" name="range" value="custom" />
        <label className="text-sm text-muted-foreground">
          From
          <input type="date" name="from" defaultValue={range.from} max={today} required className="mt-1 block min-h-11 rounded-lg border border-input bg-card px-2 text-foreground" />
        </label>
        <label className="text-sm text-muted-foreground">
          To
          <input type="date" name="to" defaultValue={range.to} max={today} required className="mt-1 block min-h-11 rounded-lg border border-input bg-card px-2 text-foreground" />
        </label>
        <button type="submit" className={`min-h-11 rounded-full px-4 text-sm font-medium ${range.preset === "custom" ? "bg-primary text-primary-foreground" : "border border-border text-foreground hover:bg-muted"}`}>
          Show custom range
        </button>
      </form>
    </div>
  );
}

function Ranked({ title, rows, empty }: { title: string; rows: Array<{ key: string; name: string; value: string }>; empty: string }) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ol className="mt-2 divide-y divide-border">
          {rows.map((r) => (
            <li key={r.key} className="flex items-baseline justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 break-words text-foreground">{r.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{r.value}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const session = await requireStoreOwner();
  const { store } = session;
  const plan = await storePlan(store.id);

  if (!planAllows(plan, "analytics-dashboard")) {
    return (
      <div className="min-h-dvh bg-background">
        <Header slug={store.slug} name={store.name} subtitle="Analytics" />
        <main className="mx-auto max-w-5xl px-4 py-6">
          <PlanLocked
            title="Analytics dashboard"
            description={`Sales by day, best sellers, repeat shoppers and how fast orders get ready. Your store is on ${PLAN_NAMES[plan]}; the per-order payout breakdown stays in Orders.`}
            storeSlug={store.slug}
          />
        </main>
      </div>
    );
  }

  const range = resolveRange(params, store.timezone);
  const [data, usage] = await Promise.all([
    storeAnalytics(store.id, store.timezone, range),
    assistantChatUsage(store.id, plan),
  ]);
  const { sales, products, customers, operations, assistant } = data;
  const csv = (view: AnalyticsView) => `/store-admin/analytics/export?store=${store.slug}&view=${view}&${rangeQuery(range)}`;
  const t = sales.totals;
  const bySeller = products.sellers.slice(0, 10);
  const byRevenue = [...products.sellers].sort((a, b) => b.revenueCents - a.revenueCents || a.name.localeCompare(b.name)).slice(0, 10);
  const swapsAsked = operations.swapsAnswered + operations.swapsTimedOut;

  return (
    <div className="min-h-dvh bg-background">
      <Header slug={store.slug} name={store.name} subtitle={`Analytics · ${fmtDay(range.from)} to ${fmtDay(range.to)}, store time`} />

      <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <nav aria-label="Analytics sections" className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4 py-2 text-sm">
          {(["sales", "products", "customers", "operations", "assistant"] as const).map((view) => (
            <a key={view} href={`#${view}`} className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 font-medium capitalize text-foreground hover:bg-muted">
              {view}
            </a>
          ))}
        </nav>
      </div>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-6">
        <RangePicker slug={store.slug} range={range} today={storeToday(store.timezone)} />

        <Section id="sales" title="Sales" note="Captured orders by the day they were placed. Net to store is after the card fee, courier fees and refunds." csvHref={csv("sales")}>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">Net to store</p>
              <p className="font-heading text-4xl font-bold tabular-nums text-foreground">{money(t.netCents)}</p>
              <div className="mt-4">
                <DayChart days={sales.days} />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-4 self-start lg:grid-cols-1">
              <Stat label="Goods revenue" value={money(t.goodsCents)} />
              <Stat label="Orders" value={count(t.orders)} detail={`Average ${money(t.averageOrderCents)}`} />
              <Stat label="Refunds" value={money(t.refundsCents)} />
              <Stat label="Card fee" value={money(t.cardFeeCents)} detail={t.courierFeeCents > 0 ? `Courier fees ${money(t.courierFeeCents)}` : undefined} />
            </dl>
          </div>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <caption className="sr-only">Sales by fulfilment</caption>
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th scope="col" className="py-2 font-medium">Fulfilment</th>
                  <th scope="col" className="py-2 text-right font-medium">Orders</th>
                  <th scope="col" className="py-2 text-right font-medium">Goods</th>
                  <th scope="col" className="py-2 text-right font-medium">Refunds</th>
                  <th scope="col" className="py-2 text-right font-medium">Net to store</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {sales.byFulfillment.map((f) => (
                  <tr key={f.fulfillment} className="border-b border-border last:border-0">
                    <th scope="row" className="py-2 text-left font-medium text-foreground">{FULFILLMENT_LABELS[f.fulfillment]}</th>
                    <td className="py-2 text-right">{count(f.orders)}</td>
                    <td className="py-2 text-right">{money(f.goodsCents)}</td>
                    <td className="py-2 text-right">{money(f.refundsCents)}</td>
                    <td className="py-2 text-right font-medium text-foreground">{money(f.netCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="mt-4 text-sm">
            <summary className="min-h-11 cursor-pointer py-2 font-medium text-foreground">Every day as a table</summary>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem]">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th scope="col" className="py-2 font-medium">Day</th>
                    <th scope="col" className="py-2 text-right font-medium">Orders</th>
                    <th scope="col" className="py-2 text-right font-medium">Goods</th>
                    <th scope="col" className="py-2 text-right font-medium">Refunds</th>
                    <th scope="col" className="py-2 text-right font-medium">Net to store</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {sales.days.map((d) => (
                    <tr key={d.day} className="border-b border-border last:border-0">
                      <th scope="row" className="py-1.5 text-left font-normal text-foreground">{fmtDay(d.day)}</th>
                      <td className="py-1.5 text-right">{count(d.orders)}</td>
                      <td className="py-1.5 text-right">{money(d.goodsCents)}</td>
                      <td className="py-1.5 text-right">{money(d.refundsCents)}</td>
                      <td className="py-1.5 text-right">{money(d.netCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </Section>

        <Section id="products" title="Products" csvHref={csv("products")}>
          <div className="grid gap-6 md:grid-cols-2">
            <Ranked title="Top sellers by units" empty="No sales in this range." rows={bySeller.map((p) => ({ key: p.listingId, name: p.name, value: `${count(p.units)} sold` }))} />
            <Ranked title="Top sellers by revenue" empty="No sales in this range." rows={byRevenue.map((p) => ({ key: p.listingId, name: p.name, value: money(p.revenueCents) }))} />
            <Ranked
              title="Most often short or swapped"
              empty="Every item was found in full."
              rows={products.shortOrSwapped.slice(0, 10).map((p) => ({ key: p.listingId, name: p.name, value: `${count(p.shortLines)} short · ${count(p.swappedLines)} swapped` }))}
            />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Searched for, not carried</h3>
              <p className="text-xs text-muted-foreground">What shoppers asked the shopping assistant for and found nothing.</p>
              {products.missedSearches.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">Every search found something.</p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {products.missedSearches.slice(0, 20).map((s) => (
                    <li key={s.query} className="max-w-full break-words rounded-full bg-muted px-3 py-1 text-sm text-foreground">
                      {s.query} <span className="tabular-nums text-muted-foreground">×{count(s.searches)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>

        <Section id="customers" title="Customers" note="Shoppers with a captured order in this range." csvHref={csv("customers")}>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Shoppers" value={count(customers.shoppers)} />
            <Stat label="Repeat rate" value={`${customers.repeatRatePct}%`} detail="Two or more orders so far" />
            <Stat label="Orders" value={count(customers.orders)} />
            <Stat label="From the assistant" value={count(customers.assistantOrders)} detail={`${pct(customers.assistantOrders, customers.orders)}% of orders`} />
          </dl>
          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <SplitBar label="New and returning shoppers" parts={[{ name: "New", value: customers.newShoppers }, { name: "Returning", value: customers.returningShoppers }]} />
            <SplitBar label="Orders by how they were built" parts={[{ name: "Shopping assistant", value: customers.assistantOrders }, { name: "Browsing", value: customers.browsingOrders }]} />
          </div>
        </Section>

        <Section id="operations" title="Operations" csvHref={csv("operations")}>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Order to ready" value={operations.medianReadyMinutes === null ? "No orders" : `${operations.medianReadyMinutes} min`} detail={operations.averageReadyMinutes === null ? undefined : `Median · average ${operations.averageReadyMinutes} min`} />
            <Stat label="Swap prompts answered" value={count(operations.swapsAnswered)} detail={swapsAsked > 0 ? `${pct(operations.swapsAnswered, swapsAsked)}% of prompts` : undefined} />
            <Stat label="Swap prompts timed out" value={count(operations.swapsTimedOut)} detail={operations.swapsPending > 0 ? `${count(operations.swapsPending)} still waiting` : undefined} />
            {operations.courier && (
              <Stat label="Courier deliveries" value={count(operations.courier.deliveries)} detail={`${count(operations.courier.delivered)} completed`} />
            )}
          </dl>
          <div className="mt-5 max-w-md">
            <Ranked
              title="Cancellations"
              empty="No cancelled orders."
              rows={operations.cancellations.map((c) => ({ key: c.reason, name: CANCEL_REASON_LABELS[c.reason] ?? c.reason, value: count(c.orders) }))}
            />
          </div>
        </Section>

        <Section id="assistant" title="Shopping assistant" csvHref={csv("assistant")}>
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">Chats this month on {PLAN_NAMES[plan]}</p>
              <p className="text-lg font-semibold tabular-nums text-foreground">{count(usage.chats)} of {count(usage.cap)}</p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label="Assistant chats used this month" aria-valuemin={0} aria-valuemax={usage.cap} aria-valuenow={usage.chats}>
                <div className={`h-full rounded-full ${usage.warning ? "bg-destructive" : "bg-primary"}`} style={{ width: `${Math.min(100, pct(usage.chats, usage.cap))}%` }} />
              </div>
            </div>
            <dl className="grid grid-cols-3 gap-4">
              <Stat label="Chats" value={count(assistant.chatsInRange)} />
              <Stat label="Added to cart" value={count(assistant.ledToCart)} detail={`${pct(assistant.ledToCart, assistant.chatsInRange)}%`} />
              <Stat label="Led to an order" value={count(assistant.ledToOrder)} detail={`${pct(assistant.ledToOrder, assistant.chatsInRange)}%`} />
            </dl>
          </div>
        </Section>
      </main>
    </div>
  );
}
