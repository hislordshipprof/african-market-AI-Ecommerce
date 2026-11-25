import Link from "next/link";
import {
  BellRing,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  FileInput,
  MessagesSquare,
  PackageSearch,
  ShieldAlert,
  Truck,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { listStores } from "@/lib/admin/actions";
import { formatAiUsd, listSpendDays } from "@/lib/admin/ai-eval-spend";
import { getAdminHomeCounts, type AdminHomeCounts, type QueueCount } from "@/lib/admin/home-counts";
import { homeOverview, type HomeOverview } from "@/lib/admin/home-overview";
import { listMetros } from "@/lib/admin/metros";
import { platformTotals } from "@/lib/admin/platform-totals";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { addDays, storeToday } from "@/lib/analytics/range";
import { assistantSpendState } from "@/lib/assistant/spend";
import { missingSetup } from "@/lib/health";

export const metadata = { title: "Home — Platform Admin" };

/** The platform's day: each store's sales are read in its own zone for this date. */
const PLATFORM_ZONE = "America/New_York";

/** What each missing setup turns off (#765); the names are the env variables, never their values. */
const SETUP_EFFECT: Record<string, string> = {
  EMAIL_FROM: "Sign-in links and order emails reach no one. Shoppers and staff are told email sign-in is not available yet.",
  R2_PROOF_BUCKET: "Store delivery and shipping are hidden at checkout: delivery photos and labels have nowhere to be kept.",
  SHIPPO_API_KEY: "Shipping is hidden at checkout: labels cannot be bought.",
};

type Queue = { href: string; label: string; count: keyof Omit<AdminHomeCounts, "stores">; detail: string; icon: LucideIcon; urgent?: boolean; testId: string };

/** Every queue an admin works, in the order design A lists them (#859). */
const QUEUES: Queue[] = [
  { href: "/admin/applications", label: "Applications to review", count: "applications", detail: "Stores waiting to hear back", icon: FileInput, testId: "count-applications" },
  { href: "/admin/orders", label: "Refunds to resolve", count: "refunds", detail: "Refunds that failed and are still owed", icon: Undo2, urgent: true, testId: "count-refunds" },
  { href: "/admin/couriers/incidents", label: "Courier incidents", count: "courierIncidents", detail: "Open incidents on courier deliveries", icon: Truck, urgent: true, testId: "count-courier-incidents" },
  { href: "/admin/store-requests", label: "Store requests", count: "storeRequests", detail: "Shoppers asking for a store near them", icon: BellRing, testId: "count-store-requests" },
  { href: "/admin/orders/check", label: "Orders to check", count: "ordersToCheck", detail: "Stuck orders and payment alerts", icon: PackageSearch, testId: "count-orders-to-check" },
  { href: "/admin/support", label: "Escalated messages", count: "messages", detail: "Threads waiting on the platform team", icon: MessagesSquare, testId: "count-messages" },
  { href: "/admin/catalog/review", label: "Catalog review", count: "catalogReview", detail: "Products awaiting review", icon: ClipboardCheck, testId: "count-catalog-review" },
  { href: "/admin/disputes", label: "Disputes", count: "disputes", detail: "Open card disputes", icon: ShieldAlert, urgent: true, testId: "count-disputes" },
];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const dollars = (cents: number) => usd.format(Math.round(cents / 100));

/** A failed read shows as not loaded; the rest of the page still renders. */
async function settle<T>(read: () => Promise<T>, what: string): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`[admin home] ${what} failed`, error);
    return null;
  }
}

export default async function AdminHome() {
  await requirePlatformAdmin();
  const now = new Date();
  const today = storeToday(PLATFORM_ZONE, now);
  const [counts, sales, stores, metros, spend, spendDays] = await Promise.all([
    getAdminHomeCounts(),
    settle(() => platformTotals(addDays(today, -7), today, now), "platform sales"),
    settle(() => listStores(), "stores"),
    settle(() => listMetros(), "metros"),
    settle(() => assistantSpendState(), "AI spend"),
    settle(() => listSpendDays(now), "AI spend days"),
  ]);
  const overview = sales?.ok && stores && metros ? homeOverview({ days: sales.days, sales: sales.stores, stores, metros }) : null;
  const missing = missingSetup(process.env);
  const waiting = QUEUES.filter((queue) => (counts[queue.count]?.count ?? 0) > 0).length;
  const unloaded = QUEUES.some((queue) => !counts[queue.count]);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${today}T12:00:00Z`));
  const dateLine = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${today}T12:00:00Z`));
  const spendSpark = Array.from({ length: 7 }, (_, index) => {
    const day = addDays(now.toISOString().slice(0, 10), index - 6);
    return Number(spendDays?.find((row) => row.day === day)?.costMicros ?? BigInt(0));
  });

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Home</h1>
      <p className="text-muted-foreground">
        {dateLine}
        {counts.stores ? `, across ${counts.stores.total} ${counts.stores.total === 1 ? "store" : "stores"}` : ""}
      </p>

      <HealthLine missing={missing} spendResting={spend?.resting ?? null} incidents={counts.courierIncidents} />


      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border xl:grid-cols-4">
        <Kpi label="GMV today" value={overview ? dollars(overview.today.goodsCents) : null}>
          {overview && <GmvChange overview={overview} weekday={weekday} />}
          {overview && <Sparkline points={overview.spark.map((day) => day.goodsCents)} />}
        </Kpi>
        <Kpi label="Orders today" value={overview ? overview.today.orders.toLocaleString("en-US") : null}>
          {overview && <p className="mt-1.5 text-[13px] text-muted-foreground">{overview.spark.reduce((sum, day) => sum + day.orders, 0).toLocaleString("en-US")} in the last 7 days</p>}
          {overview && <Sparkline points={overview.spark.map((day) => day.orders)} />}
        </Kpi>
        <StoresKpi stores={counts.stores} />
        <Kpi label="AI spend" value={spend ? formatAiUsd(spend.spentMicros) : null}>
          {spend && (
            <>
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                {spend.resting ? "At the cap: the assistant is resting" : `of the ${formatAiUsd(spend.capMicros)} cap`}
              </p>
              <Meter label="Spend against the cap" share={spend.capMicros > BigInt(0) ? Number((spend.spentMicros * BigInt(1000)) / spend.capMicros) / 1000 : 1} />
            </>
          )}
          {spendDays && <Sparkline points={spendSpark} />}
        </Kpi>
      </div>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section aria-labelledby="needs-you" className="self-start rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <h2 id="needs-you" className="font-heading text-lg font-bold text-foreground">Needs you</h2>
            <span className="text-sm text-muted-foreground">
              {waiting === QUEUES.length
                ? `All ${QUEUES.length} queues have work`
                : waiting > 0
                  ? `${waiting} of ${QUEUES.length} queues have work`
                  : unloaded
                    ? "Some counts could not be loaded"
                    : "Every queue is clear"}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {QUEUES.map((queue) => (
              <li key={queue.href}>
                <QueueLink queue={queue} counted={counts[queue.count]} />
              </li>
            ))}
          </ul>
        </section>

        <div className="grid content-start gap-6">
          <section aria-labelledby="stores-today" className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 id="stores-today" className="font-heading text-lg font-bold text-foreground">Stores today</h2>
              <Link href="/admin/stores" className="rounded text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                All stores
              </Link>
            </div>
            {!overview ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">Couldn&apos;t load today&apos;s sales.</p>
            ) : overview.storesToday.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">No orders yet today.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-left text-sm tabular-nums">
                  <thead className="border-b border-border text-[13px] text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">Store</th>
                      <th scope="col" className="px-4 py-2 font-medium">Metro</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">GMV</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Orders</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {overview.storesToday.slice(0, 8).map((row) => (
                      <tr key={row.id} className="relative hover:bg-muted">
                        <td className="max-w-[16rem] px-4 py-2.5 font-medium text-foreground">
                          <Link href={`/admin/stores/${row.id}`} className="block truncate after:absolute after:inset-0 focus-visible:outline-none">
                            {row.name}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{row.metro ?? "No metro"}</td>
                        <td className="px-4 py-2.5 text-right text-foreground">{dollars(row.goodsCents)}</td>
                        <td className="px-4 py-2.5 text-right text-foreground">{row.orders}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {overview && overview.byMetro.length > 0 && (
            <section aria-labelledby="gmv-by-metro" className="rounded-xl border border-border bg-card p-4">
              <h2 id="gmv-by-metro" className="font-heading text-lg font-bold text-foreground">GMV by metro, today</h2>
              <dl className="mt-3 grid gap-3 text-sm">
                {overview.byMetro.map((row) => (
                  <div key={row.metro ?? "none"}>
                    <div className="flex justify-between gap-3">
                      <dt className="text-foreground">{row.metro ?? "No metro"}</dt>
                      <dd className="font-semibold tabular-nums text-foreground">{dollars(row.goodsCents)}</dd>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-muted" aria-hidden>
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(2, Math.round((row.goodsCents / Math.max(1, overview.today.goodsCents)) * 100))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>
      </div>

      {missing.length > 0 && (
        <section aria-labelledby="missing-setup" className="mt-6 rounded-xl border border-border bg-card">
          <h2 id="missing-setup" className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">Missing setup</h2>
          <ul className="divide-y divide-border">
            {missing.map((name) => (
              <li key={name} className="px-4 py-3">
                <code className="block font-mono text-sm font-semibold text-foreground">{name}</code>
                <span className="mt-1 block text-sm text-muted-foreground">{SETUP_EFFECT[name]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function HealthLine({ missing, spendResting, incidents }: { missing: string[]; spendResting: boolean | null; incidents: QueueCount | null }) {
  const checks: Array<{ label: string; ok: boolean | null; href?: string }> = [
    { label: missing.includes("EMAIL_FROM") ? "Email: not set up" : "Email", ok: !missing.includes("EMAIL_FROM") },
    { label: missing.includes("R2_PROOF_BUCKET") ? "Delivery proof: not set up" : "Delivery proof", ok: !missing.includes("R2_PROOF_BUCKET") },
    { label: missing.includes("SHIPPO_API_KEY") ? "Shipping: not set up" : "Shipping", ok: !missing.includes("SHIPPO_API_KEY") },
    { label: spendResting === null ? "Assistant: not loaded" : spendResting ? "Assistant: resting at the spend cap" : "Assistant", ok: spendResting === null ? null : !spendResting, href: spendResting ? "/admin/ai/eval-spend" : undefined },
    {
      label: !incidents ? "Couriers: not loaded" : incidents.count > 0 ? `Couriers: ${incidents.count}${incidents.incomplete ? "+" : ""} open ${incidents.count === 1 ? "incident" : "incidents"}` : "Couriers",
      ok: incidents ? incidents.count === 0 : null,
      href: incidents && incidents.count > 0 ? "/admin/couriers/incidents" : undefined,
    },
  ];
  return (
    <section aria-label="Platform health" className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 text-sm">
      <span className="font-semibold text-foreground">Platform health</span>
      {checks.map((check) => {
        const Icon = check.ok === false ? CircleAlert : CircleCheck;
        const body = (
          <>
            <Icon aria-hidden className={`size-4 ${check.ok === false ? "" : check.ok ? "text-primary" : "text-muted-foreground"}`} />
            {check.label}
          </>
        );
        const tone = check.ok === false ? "font-medium text-destructive" : check.ok ? "text-foreground" : "text-muted-foreground";
        return check.href ? (
          <Link key={check.label} href={check.href} className={`inline-flex items-center gap-1.5 rounded underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${tone}`}>
            {body}
          </Link>
        ) : (
          <span key={check.label} className={`inline-flex items-center gap-1.5 ${tone}`}>{body}</span>
        );
      })}
    </section>
  );
}

function Kpi({ label, value, children }: { label: string; value: string | null; children?: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 font-heading text-[26px] font-bold leading-none tabular-nums text-foreground">
        {value ?? <span className="text-base font-medium text-muted-foreground">Couldn&apos;t load</span>}
      </p>
      {children}
    </div>
  );
}

function GmvChange({ overview, weekday }: { overview: HomeOverview; weekday: string }) {
  const change = overview.today.changePercent;
  if (change === null) return <p className="mt-1.5 text-[13px] text-muted-foreground">No sales last {weekday} to compare</p>;
  return (
    <p className={`mt-1.5 text-[13px] tabular-nums ${change >= 0 ? "text-primary" : "text-muted-foreground"}`}>
      {change >= 0 ? "+" : "−"}
      {Math.abs(change)}% on last {weekday}
    </p>
  );
}

function StoresKpi({ stores }: { stores: AdminHomeCounts["stores"] }) {
  return (
    <Link
      href="/admin/stores"
      data-testid="count-stores"
      className="min-w-0 bg-card p-4 hover:bg-muted focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <p className="text-sm text-muted-foreground">Stores live</p>
      {stores ? (
        <>
          <p className="mt-1 font-heading text-[26px] font-bold leading-none tabular-nums text-foreground">
            {stores.active} <span className="text-base font-semibold text-muted-foreground">of {stores.total}</span>
          </p>
          <p className="mt-1.5 text-[13px] tabular-nums text-muted-foreground">
            {stores.setup} in setup, {stores.suspended} suspended
          </p>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span className="bg-primary" style={{ width: `${(stores.active / Math.max(1, stores.total)) * 100}%` }} />
            <span className="bg-input" style={{ width: `${(stores.setup / Math.max(1, stores.total)) * 100}%` }} />
          </div>
        </>
      ) : (
        <p className="mt-1 text-base font-medium text-muted-foreground">Couldn&apos;t load the store count</p>
      )}
    </Link>
  );
}

function Meter({ label, share }: { label: string; share: number }) {
  const percent = Math.round(Math.min(1, Math.max(0, share)) * 100);
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}% of the cap`} className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
      <span className="block h-full bg-primary" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** A small trend line; the figures it draws are on the page or the page it links to. */
function Sparkline({ points }: { points: number[] }) {
  const max = Math.max(1, ...points);
  const step = 100 / Math.max(1, points.length - 1);
  const line = points.map((value, index) => `${(index * step).toFixed(1)},${(22 - (value / max) * 20).toFixed(1)}`).join(" ");
  return (
    <svg aria-hidden viewBox="0 0 100 24" preserveAspectRatio="none" className="mt-3 h-6 w-full text-primary">
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function QueueLink({ queue, counted }: { queue: Queue; counted: QueueCount | null }) {
  const Icon = queue.icon;
  const clear = counted?.count === 0;
  const urgent = queue.urgent && !!counted && counted.count > 0;
  return (
    <Link
      href={queue.href}
      data-testid={queue.testId}
      className="group flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-muted focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${urgent ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-foreground">{queue.label}</span>
        <span className={`block truncate text-[13px] ${urgent ? "text-destructive" : "text-muted-foreground"}`}>
          {!counted ? "Couldn't load the count" : clear ? "Nothing waiting" : queue.detail}
        </span>
      </span>
      {counted && (
        <span className={`font-heading text-[22px] font-bold leading-none tabular-nums ${clear ? "text-muted-foreground" : "text-foreground"}`}>
          {counted.incomplete && <span className="sr-only">At least </span>}
          {counted.count}
          {counted.incomplete && <span aria-hidden>+</span>}
        </span>
      )}
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
    </Link>
  );
}
