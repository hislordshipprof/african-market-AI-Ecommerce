"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { OwnerReportPanel } from "./copilot/owner-report-panel";
import { PlanLocked } from "@/components/store-admin/plan-locked";
import type { GoLiveItemView } from "@/components/go-live/go-live-items";
import { displayAddress } from "@/lib/directory/links";
import { money } from "@/lib/format";
import { orderStatusLabel, FULFILLMENT_LABELS } from "@/lib/order/status-labels";
import { compareToLastWeek, type NeedsItem } from "@/lib/store-admin/home-needs";
import type { StoreHome } from "@/lib/store-admin/home";
import { GoLiveCard, LiveNotice } from "./go-live-card";
import {
  AlertCircle,
  ArrowLeftRight,
  BellRing,
  Camera,
  ChevronRight,
  Copy,
  ExternalLink,
  Info,
  MessageSquare,
  MessagesSquare,
  PackageOpen,
  ShoppingBag,
  TrendingDown,
  TrendingUp,
  ListChecks,
  type LucideIcon,
} from "lucide-react";

interface Props {
  storeSlug: string;
  role: string;
  timeZone: string;
  /** Null when the store has no opening hours set. */
  openNow: boolean | null;
  home: StoreHome;
  needs: NeedsItem[];
  /** Orders placed by shoppers who arrived from the Store directory (#454). */
  directoryOrders: number;
  /** The go-live checklist while the store is in setup (#555); null once it is live. */
  goLive: GoLiveItemView[] | null;
  /** Where shoppers reach the store (#784); null when the slug cannot be routed. */
  storeAddress: string | null;
  minimumOrderCents: number;
  /** The store's address has a map point, so the directory can show it (#786). */
  located: boolean;
  plan: {
    name: string;
    status: string;
    paymentFailed: boolean;
    /** The owner's assistant chats this month; null for staff. */
    usage: { used: number; cap: number; capped: boolean; warning: boolean } | null;
    readOnly: boolean;
    reportsAllowed: boolean;
    analyticsAllowed: boolean;
    ownDomainAllowed: boolean;
  };
}

const NEED_ICONS: Record<NeedsItem["kind"], LucideIcon> = {
  orders: BellRing,
  swap: ArrowLeftRight,
  payouts: AlertCircle,
  stock: PackageOpen,
  messages: MessagesSquare,
  "go-live": ListChecks,
};

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** Store admin Home (#860): today's numbers, what needs the owner now, recent orders and the week. */
export function StoreAdminDashboard({
  storeSlug,
  role,
  timeZone,
  openNow,
  home,
  needs,
  directoryOrders,
  goLive,
  storeAddress,
  minimumOrderCents,
  located,
  plan,
}: Props) {
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;
  const store = `?store=${encodeURIComponent(storeParam)}`;
  const [justLive, setJustLive] = useState(false);
  const isOwner = role === "owner";
  const waiting = home.newOrders.count;
  const date = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(
    new Date(`${home.today.day}T12:00:00Z`),
  );
  const change = compareToLastWeek(home.today.salesCents, home.today.lastWeekCents);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(`${home.today.day}T12:00:00Z`));
  const summary = [
    openNow === null ? null : openNow ? "Store open now." : "Store closed now.",
    waiting > 0 ? `${plural(waiting, "order is", "orders are")} waiting for you.` : "No new orders waiting.",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{date}</h1>
          <p className="mt-1 text-muted-foreground">{summary}</p>
        </div>
        <Link href={`/store-admin/orders${store}`} className={buttonVariants({ className: "min-h-12 rounded-full px-6 text-base" })}>
          <ShoppingBag aria-hidden className="size-4" />
          Open orders
        </Link>
      </header>

      {justLive && <LiveNotice storeAddress={storeAddress} storeParam={storeParam} minimumOrderCents={minimumOrderCents} located={located} />}
      {goLive && (
        <GoLiveCard items={goLive} isOwner={isOwner} minimumOrderCents={minimumOrderCents} located={located} onLive={() => setJustLive(true)} />
      )}

      {isOwner && plan.paymentFailed && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          <div className="text-sm">
            <p className="font-semibold text-foreground">Your subscription payment failed.</p>
            <p className="text-muted-foreground">
              Your store stays open.{" "}
              <Link href={`/store-admin/plan${store}`} className="font-medium text-primary underline underline-offset-4">
                Update your card
              </Link>
            </p>
          </div>
        </div>
      )}
      {isOwner && plan.usage?.warning && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
          <Info className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">
            {plan.usage.capped
              ? "Your shopping assistant has used this month's chats and is paused. Shoppers keep buying by browsing."
              : `Your shopping assistant has used ${plan.usage.used.toLocaleString("en-US")} of ${plan.usage.cap.toLocaleString("en-US")} chats this month.`}{" "}
            <Link href={`/store-admin/plan${store}`} className="font-medium text-primary underline underline-offset-4">
              See plans
            </Link>
          </p>
        </div>
      )}
      {plan.readOnly && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
          <Info className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">
            You have read-only access. The store&apos;s plan has no seat left for you; ask the owner to upgrade or free a seat.
          </p>
        </div>
      )}

      <section aria-label="Today" className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4" data-testid="today-strip">
        <Stat label="Sales today" value={money(home.today.salesCents)} testId="stat-sales">
          {change === null ? (
            <span>Nothing sold last {weekday}</span>
          ) : (
            <span className={`inline-flex items-center gap-1 ${change >= 0 ? "text-success" : "text-destructive"}`}>
              {change >= 0 ? <TrendingUp className="size-3.5" aria-hidden /> : <TrendingDown className="size-3.5" aria-hidden />}
              {Math.abs(change)}% {change >= 0 ? "up on" : "down on"} last {weekday}
            </span>
          )}
        </Stat>
        <Stat label="Orders" value={home.today.orders.toLocaleString("en-US")} testId="stat-orders">
          {home.today.orders > 0 ? `Average basket ${money(home.today.averageBasketCents)}` : "Paid orders today"}
        </Stat>
        <Stat label="To pack" value={home.toPack.total.toLocaleString("en-US")} testId="stat-to-pack">
          {home.toPack.fresh} new, {home.toPack.packing} packing
        </Stat>
        <Stat label="Low stock" value={home.lowStock.count.toLocaleString("en-US")} testId="stat-low-stock">
          {home.lowStock.names.length > 0 ? `${home.lowStock.names.join(" and ")} first` : "Nothing running low"}
        </Stat>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card className="gap-0 py-0">
            <h2 className="border-b border-border px-4 py-4 font-heading text-lg font-bold text-foreground sm:px-5">Needs you now</h2>
            {needs.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">You&apos;re all caught up.</p>
            ) : (
              <ul className="divide-y divide-border" data-testid="needs-you-now">
                {needs.map((item) => {
                  const Icon = NEED_ICONS[item.kind];
                  return (
                    <li key={item.key}>
                      <Link
                        href={item.href}
                        className="group flex min-h-16 items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 sm:px-5"
                      >
                        <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${item.kind === "payouts" ? "bg-destructive/10 text-destructive" : "bg-secondary text-primary"}`}>
                          <Icon className="size-4" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold text-foreground">{item.title}</span>
                          {item.detail && <span className="block text-sm text-muted-foreground">{item.detail}</span>}
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="gap-0 py-0">
            <div className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-5">
              <h2 className="font-heading text-lg font-bold text-foreground">Recent orders</h2>
              <Link href={`/store-admin/orders${store}`} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
                All orders
              </Link>
            </div>
            {home.recent.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">No orders yet. They show here as soon as shoppers buy.</p>
            ) : (
              <ul className="divide-y divide-border" data-testid="recent-orders">
                {home.recent.map((order) => (
                  <li key={order.id}>
                    <Link
                      href={order.active ? `/store-admin/orders/${order.id}${store}` : `/store-admin/orders/past/${order.id}${store}`}
                      className="flex min-h-14 items-center gap-3 px-4 py-2.5 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 sm:px-5"
                    >
                      <span className="w-14 shrink-0 text-sm font-semibold tabular-nums text-foreground">#{order.number}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">{order.customerName}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {FULFILLMENT_LABELS[order.fulfillment] ?? order.fulfillment} · {orderStatusLabel(order.status, order.fulfillment)}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">{money(order.totalCents)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {!isOwner && !plan.readOnly && plan.reportsAllowed && (
            <Card className="px-6">
              <OwnerReportPanel submitOnly />
            </Card>
          )}
          {!isOwner && !plan.reportsAllowed && (
            <PlanLocked
              title="Voice and photo stock reports"
              description="Tell the store what came in by voice or a photo of the invoice."
              storeSlug={storeParam}
              canUpgrade={false}
            />
          )}
        </div>

        <aside className="min-w-0 space-y-6" aria-label="Your store">
          {storeAddress && (
            <Card className="gap-3 px-4 sm:px-5">
              <h2 className="font-heading text-lg font-bold text-foreground">Your store&apos;s web address</h2>
              <p className="break-all font-medium text-foreground" data-testid="store-address">{displayAddress(storeAddress)}</p>
              <div className="flex flex-wrap gap-2">
                <CopyLink address={storeAddress} />
                <a
                  href={storeAddress}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ variant: "outline", className: "min-h-11 rounded-full" })}
                  data-testid="address-view-store"
                >
                  <ExternalLink aria-hidden className="size-4" />
                  View store
                </a>
              </div>
            </Card>
          )}

          <WeekChart week={home.week} store={store} isOwner={isOwner} />

          {isOwner && (
            <Card className="gap-3 px-4 sm:px-5" data-testid="this-month">
              <h2 className="font-heading text-lg font-bold text-foreground">This month</h2>
              <dl className="grid gap-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Plan</dt>
                  <dd className="font-medium text-foreground">
                    {plan.name}
                    {plan.status === "trialing" && " (free trial)"}
                    {plan.status === "none" && " (choose a plan)"}
                  </dd>
                </div>
                {plan.usage && (
                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">Assistant chats</dt>
                      <dd className="font-medium tabular-nums text-foreground">
                        {plan.usage.used.toLocaleString("en-US")} of {plan.usage.cap.toLocaleString("en-US")}
                      </dd>
                    </div>
                    <div
                      className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
                      role="meter"
                      aria-label="Assistant chats used this month"
                      aria-valuemin={0}
                      aria-valuemax={plan.usage.cap}
                      aria-valuenow={Math.min(plan.usage.used, plan.usage.cap)}
                    >
                      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, plan.usage.cap > 0 ? (plan.usage.used / plan.usage.cap) * 100 : 0)}%` }} />
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Orders from the directory</dt>
                  <dd className="font-medium tabular-nums text-foreground">{directoryOrders.toLocaleString("en-US")}</dd>
                </div>
              </dl>
              <Link href={`/store-admin/plan${store}`} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
                Plan and usage
              </Link>
            </Card>
          )}

          <Card className="gap-1 px-2 py-2">
            <h2 className="sr-only">Tools</h2>
            {isOwner && (
              <ToolLink href={`/store-admin/copilot${store}`} icon={MessageSquare} title="Copilot" detail="Report stock in a sentence" />
            )}
            {!isOwner && !plan.readOnly && (
              <ToolLink href={`/store-admin/listings/from-photos${store}`} icon={Camera} title="Shelf photos" detail="Photograph shelves to draft new listings" />
            )}
            {isOwner && !plan.analyticsAllowed && (
              <div className="px-2 py-2">
                <PlanLocked title="Analytics dashboard" description="Sales, best sellers and repeat shoppers at a glance." storeSlug={storeParam} />
              </div>
            )}
            {isOwner && !plan.ownDomainAllowed && (
              <div className="px-2 py-2">
                <PlanLocked title="Your own domain" description="Serve your store at your own web address." storeSlug={storeParam} />
              </div>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, testId, children }: { label: string; value: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="bg-card p-4 sm:p-5" data-testid={testId}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 font-heading text-2xl font-bold tabular-nums text-foreground sm:text-3xl">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

function WeekChart({ week, store, isOwner }: { week: StoreHome["week"]; store: string; isOwner: boolean }) {
  const max = Math.max(...week.map((day) => day.salesCents), 1);
  const total = week.reduce((sum, day) => sum + day.salesCents, 0);
  const label = (day: string, style: "narrow" | "long") =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: style }).format(new Date(`${day}T12:00:00Z`));
  return (
    <Card className="gap-3 px-4 sm:px-5" data-testid="week-chart">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-heading text-lg font-bold text-foreground">Sales this week</h2>
        <span className="text-sm tabular-nums text-muted-foreground">{money(total)}</span>
      </div>
      <ol className="flex h-36 items-end gap-2" aria-label="Sales on each of the last seven days">
        {week.map((day, index) => {
          const today = index === week.length - 1;
          return (
            <li key={day.day} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
              <span className="sr-only">
                {label(day.day, "long")}: {money(day.salesCents)}
              </span>
              <span
                aria-hidden
                title={`${label(day.day, "long")}: ${money(day.salesCents)}`}
                className={`w-full rounded-t-md ${today ? "bg-primary" : "bg-muted-foreground/35"}`}
                style={{ height: `${Math.max(2, (day.salesCents / max) * 100)}%` }}
              />
              <span aria-hidden className={`text-xs ${today ? "font-bold text-foreground" : "text-muted-foreground"}`}>
                {label(day.day, "narrow")}
              </span>
            </li>
          );
        })}
      </ol>
      {isOwner && (
        <Link href={`/store-admin/analytics${store}`} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
          Open analytics
        </Link>
      )}
    </Card>
  );
}

function ToolLink({ href, icon: Icon, title, detail }: { href: string; icon: LucideIcon; title: string; detail: string }) {
  return (
    <Link href={href} className="flex min-h-14 items-center gap-3 rounded-lg px-3 py-2 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
      <Icon className="size-5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-foreground">{title}</span>
        <span className="block text-sm text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

function CopyLink({ address }: { address: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard.writeText(address).then(
          () => setCopied("copied"),
          () => setCopied("failed"),
        )
      }
      className={buttonVariants({ variant: "outline", className: "min-h-11 rounded-full" })}
    >
      <Copy aria-hidden className="size-4" />
      <span aria-live="polite">{copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy link"}</span>
    </button>
  );
}
