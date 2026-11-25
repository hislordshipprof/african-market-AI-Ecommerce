import Link from "next/link";
import { AlertCircle, MessageCircle, Store } from "lucide-react";
import { requireStoreOwner } from "@/lib/store-admin/session";
import { getStoreBilling, PILOT_FREE_MONTHS, syncCheckoutReturn } from "@/lib/billing/service";
import { assistantChatUsage } from "@/lib/billing/assistant-chats";
import { PLAN_NAMES, PLAN_PRICES_USD, PLANS, RECOMMENDED_PLAN, supportLevel, billingStatusLabel } from "@/lib/billing/plan";
import { applicantPlanChoice } from "@/lib/store-application/service";
import { PlanComparison } from "@/components/billing/plan-comparison";
import { choosePlanAction, manageBillingAction } from "@/lib/billing/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" });
/** An override ends at the start of its UTC date, the date the admin picked. */
const overrideFormat = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ pending?: string; session_id?: string | string[] }>;
}) {
  const { pending, session_id: sessionId } = await searchParams;
  const session = await requireStoreOwner();
  let billing = await getStoreBilling(session.store.id);
  // Back from Stripe Checkout: show the plan now instead of waiting for the webhook (#841).
  const returned = typeof sessionId === "string";
  if (returned && !billing.subscribed && (await syncCheckoutReturn(session.store.id, sessionId))) {
    billing = await getStoreBilling(session.store.id);
  }
  const [usage, applied] = await Promise.all([
    assistantChatUsage(session.store.id, billing.plan),
    applicantPlanChoice(session.store.id),
  ]);
  // The plan the applicant said they wanted on /sell comes first; "Not sure yet" or no application falls back (#838).
  const appliedPlan = applied === "starter" || applied === "pro" ? applied : null;
  const preselected = appliedPlan ?? RECOMMENDED_PLAN;
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

        {(pending === "1" || returned) && !billing.subscribed && (
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
                  {billingStatusLabel(billing.status)}
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
              {billing.override && (
                <p className="mt-2 text-sm text-foreground" data-testid="plan-override">
                  {PLAN_NAMES[billing.override.plan]}, courtesy of the platform team until {overrideFormat.format(billing.override.endsAt)}.
                </p>
              )}
              {billing.pilotTrialAvailable && (
                <p className="mt-2 text-sm text-foreground">Your first {PILOT_FREE_MONTHS} months are free. Choose a plan to start.</p>
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
              {PLANS.map((plan) => (
                <form
                  key={plan}
                  action={choosePlanAction}
                  className={`flex flex-col rounded-xl border bg-card p-5 ${plan === preselected ? "border-primary" : "border-border"}`}
                >
                  <input type="hidden" name="plan" value={plan} />
                  <h3 className="text-base font-semibold text-foreground">{PLAN_NAMES[plan]}</h3>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                    ${PLAN_PRICES_USD[plan]}
                    <span className="text-sm font-normal text-muted-foreground"> / month</span>
                  </p>
                  {plan === appliedPlan && (
                    <p className="mt-2 text-sm text-foreground">You chose {PLAN_NAMES[plan]} when you applied.</p>
                  )}
                  <Button type="submit" className="mt-5 min-h-11" variant={plan === preselected ? "default" : "outline"}>
                    {billing.pilotTrialAvailable ? `Start ${PLAN_NAMES[plan]}, ${PILOT_FREE_MONTHS} months free` : `Choose ${PLAN_NAMES[plan]}`}
                  </Button>
                </form>
              ))}
            </div>
          </section>
        )}

        <PlanComparison currentPlan={billing.plan} />
      </main>
    </div>
  );
}
