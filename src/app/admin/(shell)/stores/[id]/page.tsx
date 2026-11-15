import { notFound } from "next/navigation";
import { getStoreById, getStoreSubscription, retryCourierRegistrationAction, setPilotAction, setPlanOverrideAction } from "@/lib/admin/actions";
import { billingStatusLabel, PLAN_NAMES, type Plan } from "@/lib/billing/plan";
import { PILOT_FREE_MONTHS, PILOT_STORE_CAP, PLAN_OVERRIDE_MAX_DAYS } from "@/lib/billing/service";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { getStoreNumber, storeNumberLinkMode } from "@/lib/whatsapp/store-number";
import { StoreForm } from "../store-form";
import { InviteOwnerForm } from "./invite-owner-form";
import { WhatsAppNumberSection } from "./whatsapp-number-section";
import { GoLiveSection } from "./go-live-section";

function courierState(id: string | null, error: string | null): string {
  if (id) return `Registered · ${id}`;
  if (error) return `Failed · ${error}`;
  return "Not registered";
}

export default async function EditStorePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pilotError?: string; courierRetry?: string; override?: string; overrideError?: string; goLive?: string; goLiveError?: string }>;
}) {
  await requirePlatformAdmin();
  const { id } = await params;
  const { pilotError, courierRetry, override, overrideError, goLive, goLiveError } = await searchParams;
  const store = await getStoreById(id);
  if (!store) notFound();
  const [subscription, storeNumber] = await Promise.all([getStoreSubscription(store.id), getStoreNumber(store.id)]);
  const plan = PLAN_NAMES[subscription?.plan ?? "starter"];

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="mb-6 text-2xl font-bold text-foreground">
        Edit: {store.name}
      </h1>
      <GoLiveSection storeId={store.id} forced={goLive === "forced"} error={goLiveError} />
      <section aria-labelledby="billing" className="mb-8 rounded-lg border border-border bg-card p-5">
        <h2 id="billing" className="text-base font-semibold text-foreground">Plan and billing</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {plan} · {billingStatusLabel(subscription?.status ?? "none")}
          {subscription?.trialEndsAt && ` · trial ends ${subscription.trialEndsAt.toISOString().slice(0, 10)}`}
          {subscription?.paymentFailedAt && " · last payment failed"}
        </p>
        <form action={setPilotAction} className="mt-4 flex flex-wrap items-center gap-3">
          <input type="hidden" name="storeId" value={store.id} />
          <input type="hidden" name="pilot" value={subscription?.pilot ? "false" : "true"} />
          <button
            type="submit"
            className="min-h-11 rounded-full border border-primary px-5 text-sm font-medium text-primary hover:bg-secondary"
          >
            {subscription?.pilot ? "Remove pilot offer" : `Make a pilot store (${PILOT_FREE_MONTHS} months free)`}
          </button>
          <span className="text-sm text-muted-foreground">
            {subscription?.pilot
              ? "This store is a pilot store. Removing the offer during the free months charges the store now."
              : `Up to ${PILOT_STORE_CAP} pilot stores.`}
          </span>
        </form>
        {pilotError && (
          <p role="alert" className="mt-2 text-sm text-destructive">{pilotError}</p>
        )}
        <PlanOverrideForm
          storeId={store.id}
          stripePlan={(subscription?.stripePlan ?? "starter") as Plan}
          running={subscription?.overridePlan && subscription.overrideEndsAt
            ? { plan: subscription.overridePlan as Plan, endsAt: subscription.overrideEndsAt, reason: subscription.overrideReason ?? "" }
            : null}
          saved={override === "saved"}
          error={overrideError}
        />
      </section>
      <section aria-labelledby="couriers" className="mb-8 rounded-lg border border-border bg-card p-5">
        <h2 id="couriers" className="text-base font-semibold text-foreground">Courier registration</h2>
        <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="font-medium text-foreground">Uber Direct</dt>
          <dd className="break-words text-muted-foreground">{courierState(store.uberLocationId, store.uberRegistrationError)}</dd>
          <dt className="font-medium text-foreground">DoorDash</dt>
          <dd className="break-words text-muted-foreground">{courierState(store.doordashStoreId, store.doordashRegistrationError)}</dd>
        </dl>
        {(!store.uberLocationId || !store.doordashStoreId) && (
          <form action={retryCourierRegistrationAction} className="mt-4 flex flex-wrap items-center gap-3">
            <input type="hidden" name="storeId" value={store.id} />
            <button
              type="submit"
              className="min-h-11 rounded-full border border-primary px-5 text-sm font-medium text-primary hover:bg-secondary"
            >
              Retry registration
            </button>
            <span role="status" className="text-sm text-muted-foreground">
              {courierRetry === "queued"
                ? "Registration queued. Refresh in a minute to see the result."
                : courierRetry === "failed"
                  ? "Registration could not be queued. Try again, or the daily retry will pick it up."
                  : "Registration runs once the store has a full address, and again every day until it succeeds."}
            </span>
          </form>
        )}
      </section>
      <WhatsAppNumberSection
        storeId={store.id}
        mode={storeNumberLinkMode()}
        number={storeNumber && {
          status: storeNumber.status,
          wabaId: storeNumber.wabaId,
          phoneNumberId: storeNumber.phoneNumberId,
          displayNumber: storeNumber.displayNumber,
          coexistence: storeNumber.coexistence,
          failureCode: storeNumber.failureCode,
        }}
      />
      <StoreForm mode="edit" store={store} />
      <div className="mt-8">
        <InviteOwnerForm storeId={store.id} />
      </div>
    </div>
  );
}

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const FIELD = "min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Time-boxed plan override (#547): drives the plan gate, never touches Stripe. */
function PlanOverrideForm({
  storeId,
  stripePlan,
  running,
  saved,
  error,
}: {
  storeId: string;
  stripePlan: Plan;
  running: { plan: Plan; endsAt: Date; reason: string } | null;
  saved: boolean;
  error?: string;
}) {
  return (
    <form action={setPlanOverrideAction} className="mt-6 border-t border-border pt-5" aria-labelledby="override-title">
      <h3 id="override-title" className="text-sm font-semibold text-foreground">Plan override</h3>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="override-state">
        {running
          ? `${PLAN_NAMES[running.plan]} until ${dateFormat.format(running.endsAt)} (${running.reason}). Stripe plan: ${PLAN_NAMES[stripePlan]}.`
          : `No override. The store runs on its Stripe plan. An override ends on its date, at most ${PLAN_OVERRIDE_MAX_DAYS} days out, and never changes what Stripe bills.`}
      </p>
      <input type="hidden" name="storeId" value={storeId} />
      <div className="mt-3 grid gap-3 sm:grid-cols-[10rem_12rem]">
        <div className="grid gap-1.5">
          <label htmlFor="override-plan" className="text-sm font-medium text-foreground">Plan</label>
          <select id="override-plan" name="plan" defaultValue={running?.plan ?? "pro"} className={FIELD}>
            <option value="pro">{PLAN_NAMES.pro}</option>
            <option value="starter">{PLAN_NAMES.starter}</option>
          </select>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="override-ends" className="text-sm font-medium text-foreground">Ends on (UTC)</label>
          <input id="override-ends" name="endsOn" type="date" required className={FIELD} />
        </div>
      </div>
      <div className="mt-3 grid gap-1.5">
        <label htmlFor="override-reason" className="text-sm font-medium text-foreground">Reason</label>
        <input id="override-reason" name="reason" required maxLength={500} placeholder="For example: launch partner, comped for 3 months" className={FIELD} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="submit" className="min-h-11 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          {running ? "Replace override" : "Set override"}
        </button>
        {saved && !error && <span role="status" className="text-sm text-muted-foreground">Override saved.</span>}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </form>
  );
}
