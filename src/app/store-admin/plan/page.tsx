import Link from "next/link";
import { AlertCircle, Check, Lock, MessageCircle, Store } from "lucide-react";
import { requireStoreOwner } from "@/lib/store-admin/session";
import { getStoreBilling } from "@/lib/billing/service";
import { assistantChatUsage } from "@/lib/billing/assistant-chats";
import {
  FEATURE_LABELS,
  PLAN_NAMES,
  PLAN_PRICES_USD,
  RECOMMENDED_PLAN,
  PRO_FEATURES,
  assistantChatCap,
  planAllows,
  staffLimit,
  supportLevel,
  type Plan,
} from "@/lib/billing/plan";
import { choosePlanAction, manageBillingAction } from "@/lib/billing/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const STATUS_LABELS: Record<string, string> = {
  none: "Not subscribed",
  trialing: "Free trial",
  active: "Active",
  past_due: "Payment failed",
  unpaid: "Unpaid",
  canceled: "Cancelled",
  incomplete: "Waiting for card",
  incomplete_expired: "Not started",
  paused: "Paused",
};

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" });

function planLines(plan: Plan): string[] {
  const staff = staffLimit(plan);
  return [
    "Branded store, catalog, orders, refunds and payouts",
    "Allergy and diet rules, swap or refund prompts",
    `${assistantChatCap(plan).toLocaleString("en-US")} shopping-assistant chats a month`,
    staff === null ? "Unlimited staff" : `Owner + ${staff} staff`,
    `Support: ${supportLevel(plan).toLowerCase()}`,
    ...(planAllows(plan, "courier-delivery") ? [] : ["Pickup and your own delivery"]),
    ...PRO_FEATURES.filter((f) => planAllows(plan, f)).map((f) => FEATURE_LABELS[f]),
  ];
}

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ pending?: string }> }) {
  const { pending } = await searchParams;
  const session = await requireStoreOwner();
  const billing = await getStoreBilling(session.store.id);
  const usage = await assistantChatUsage(session.store.id, billing.plan);
  const slug = session.store.slug;
  const usedPct = Math.min(100, Math.round((usage.chats / usage.cap) * 100));

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
          <Link
            href={`/store-admin?store=${slug}`}
            className="flex min-h-11 items-center gap-2 rounded-lg bg-primary px-3 text-primary-foreground"
          >
            <Store className="size-5" aria-hidden />
            <span className="text-sm font-semibold">Dashboard</span>
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-foreground">{session.store.name}</h1>
            <p className="text-xs text-muted-foreground">Plan and billing</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        {billing.paymentFailedAt && (
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
            <div className="text-sm">
              <p className="font-semibold text-foreground">Your last subscription payment failed.</p>
              <p className="text-muted-foreground">Your store stays open. Update your card so Stripe can retry the payment.</p>
            </div>
          </div>
        )}

        {pending === "1" && !billing.subscribed && (
          <div role="status" className="rounded-xl border border-border bg-card p-4 text-sm text-foreground">
            Your payment went through. Your plan shows here within a minute; refresh to see it.
          </div>
        )}

        <section aria-labelledby="current-plan" className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 id="current-plan" className="text-lg font-semibold text-foreground">
                {PLAN_NAMES[billing.plan]} plan
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant={billing.status === "past_due" ? "destructive" : "secondary"}>
                  {STATUS_LABELS[billing.status] ?? billing.status}
                </Badge>
                {billing.pilot && <Badge variant="outline">Pilot store</Badge>}
                {billing.status === "trialing" && billing.trialEndsAt && (
                  <span>Free until {dateFormat.format(billing.trialEndsAt)}</span>
                )}
                {billing.status === "active" && billing.currentPeriodEnd && (
                  <span>
                    {billing.cancelAtPeriodEnd ? "Ends" : "Renews"} {dateFormat.format(billing.currentPeriodEnd)}
                  </span>
                )}
              </div>
              {billing.pilotTrialAvailable && (
                <p className="mt-2 text-sm text-foreground">Your first 3 months are free. Choose a plan to start.</p>
              )}
            </div>
            {billing.hasCustomer && billing.subscribed && (
              <form action={manageBillingAction}>
                <Button type="submit" variant="outline" className="min-h-11">
                  Change plan, card or cancel
                </Button>
              </form>
            )}
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <MessageCircle className="size-4 text-muted-foreground" aria-hidden />
                Shopping-assistant chats this month
              </p>
              <p className="mt-1 text-sm tabular-nums text-muted-foreground">
                {usage.chats.toLocaleString("en-US")} of {usage.cap.toLocaleString("en-US")}
              </p>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label="Assistant chats used"
                aria-valuemin={0}
                aria-valuemax={usage.cap}
                aria-valuenow={usage.chats}
              >
                <div
                  className={`h-full rounded-full ${usage.warning ? "bg-destructive" : "bg-primary"}`}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
              {usage.capped ? (
                <p className="mt-2 text-sm text-foreground">The assistant is paused until next month. Shoppers keep buying by browsing.</p>
              ) : usage.warning ? (
                <p className="mt-2 text-sm text-foreground">You have used 80% of this month&apos;s chats.</p>
              ) : null}
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Support</p>
              <p className="mt-1 text-sm text-muted-foreground">{supportLevel(billing.plan)}</p>
            </div>
          </div>
        </section>

        {!billing.subscribed && (
          <section aria-labelledby="choose-plan">
            <h2 id="choose-plan" className="mb-3 text-lg font-semibold text-foreground">
              Choose a plan
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {(["starter", "pro"] as const).map((plan) => (
                <form
                  key={plan}
                  action={choosePlanAction}
                  className={`flex flex-col rounded-xl border bg-card p-5 ${plan === RECOMMENDED_PLAN ? "border-primary" : "border-border"}`}
                >
                  <input type="hidden" name="plan" value={plan} />
                  <h3 className="text-base font-semibold text-foreground">{PLAN_NAMES[plan]}</h3>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                    ${PLAN_PRICES_USD[plan]}
                    <span className="text-sm font-normal text-muted-foreground"> / month</span>
                  </p>
                  <ul className="mt-4 flex-1 space-y-2 text-sm text-foreground">
                    {planLines(plan).map((line) => (
                      <li key={line} className="flex gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                        {line}
                      </li>
                    ))}
                  </ul>
                  <Button type="submit" className="mt-5 min-h-11" variant={plan === RECOMMENDED_PLAN ? "default" : "outline"}>
                    {billing.pilotTrialAvailable ? `Start ${PLAN_NAMES[plan]}, 3 months free` : `Choose ${PLAN_NAMES[plan]}`}
                  </Button>
                </form>
              ))}
            </div>
          </section>
        )}

        <section aria-labelledby="pro-features" className="rounded-xl border border-border bg-card p-5">
          <h2 id="pro-features" className="text-base font-semibold text-foreground">
            Pro features
          </h2>
          <ul className="mt-3 divide-y divide-border">
            {PRO_FEATURES.map((feature) => {
              const allowed = planAllows(billing.plan, feature);
              return (
                <li key={feature} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm">
                  <span className="flex items-center gap-2 text-foreground">
                    {allowed ? (
                      <Check className="size-4 text-primary" aria-hidden />
                    ) : (
                      <Lock className="size-4 text-muted-foreground" aria-hidden />
                    )}
                    {FEATURE_LABELS[feature]}
                    {(feature === "whatsapp" || feature === "analytics-dashboard" || feature === "own-domain") && (
                      <span className="text-muted-foreground">(coming soon)</span>
                    )}
                  </span>
                  <span className={allowed ? "text-muted-foreground" : "font-medium text-foreground"}>
                    {allowed ? "Included" : "Pro"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </main>
    </div>
  );
}
