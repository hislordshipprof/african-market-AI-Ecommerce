import { notFound } from "next/navigation";
import { getStoreById, getStoreSubscription, retryCourierRegistrationAction, setPilotAction } from "@/lib/admin/actions";
import { effectivePlan, PLAN_NAMES } from "@/lib/billing/plan";
import { PILOT_FREE_MONTHS, PILOT_STORE_CAP } from "@/lib/billing/service";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { StoreForm } from "../store-form";
import { InviteOwnerForm } from "./invite-owner-form";

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
  searchParams: Promise<{ pilotError?: string; courierRetry?: string }>;
}) {
  await requirePlatformAdmin();
  const { id } = await params;
  const { pilotError, courierRetry } = await searchParams;
  const store = await getStoreById(id);
  if (!store) notFound();
  const subscription = await getStoreSubscription(store.id);
  const plan = PLAN_NAMES[effectivePlan(subscription)];

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="mb-6 text-2xl font-bold text-[#15201A]">
        Edit: {store.name}
      </h1>
      <section aria-labelledby="billing" className="mb-8 rounded-lg border border-[#e2e4e9] bg-white p-5">
        <h2 id="billing" className="text-base font-semibold text-[#15201A]">Plan and billing</h2>
        <p className="mt-1 text-sm text-[#55625A]">
          {plan} · {subscription?.status ?? "none"}
          {subscription?.trialEndsAt && ` · trial ends ${subscription.trialEndsAt.toISOString().slice(0, 10)}`}
          {subscription?.paymentFailedAt && " · last payment failed"}
        </p>
        <form action={setPilotAction} className="mt-4 flex flex-wrap items-center gap-3">
          <input type="hidden" name="storeId" value={store.id} />
          <input type="hidden" name="pilot" value={subscription?.pilot ? "false" : "true"} />
          <button
            type="submit"
            className="min-h-11 rounded-full border border-[#1F5A43] px-5 text-sm font-medium text-[#1F5A43] hover:bg-[#EBF3EC]"
          >
            {subscription?.pilot ? "Remove pilot offer" : `Make a pilot store (${PILOT_FREE_MONTHS} months free)`}
          </button>
          <span className="text-sm text-[#55625A]">
            {subscription?.pilot
              ? "This store is a pilot store. Removing the offer during the free months charges the store now."
              : `Up to ${PILOT_STORE_CAP} pilot stores.`}
          </span>
        </form>
        {pilotError && (
          <p role="alert" className="mt-2 text-sm text-red-700">{pilotError}</p>
        )}
      </section>
      <section aria-labelledby="couriers" className="mb-8 rounded-lg border border-[#e2e4e9] bg-white p-5">
        <h2 id="couriers" className="text-base font-semibold text-[#15201A]">Courier registration</h2>
        <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="font-medium text-[#15201A]">Uber Direct</dt>
          <dd className="break-words text-[#55625A]">{courierState(store.uberLocationId, store.uberRegistrationError)}</dd>
          <dt className="font-medium text-[#15201A]">DoorDash</dt>
          <dd className="break-words text-[#55625A]">{courierState(store.doordashStoreId, store.doordashRegistrationError)}</dd>
        </dl>
        {(!store.uberLocationId || !store.doordashStoreId) && (
          <form action={retryCourierRegistrationAction} className="mt-4 flex flex-wrap items-center gap-3">
            <input type="hidden" name="storeId" value={store.id} />
            <button
              type="submit"
              className="min-h-11 rounded-full border border-[#1F5A43] px-5 text-sm font-medium text-[#1F5A43] hover:bg-[#EBF3EC]"
            >
              Retry registration
            </button>
            <span role="status" className="text-sm text-[#55625A]">
              {courierRetry === "queued"
                ? "Registration queued. Refresh in a minute to see the result."
                : courierRetry === "failed"
                  ? "Registration could not be queued. Try again, or the daily retry will pick it up."
                  : "Registration runs once the store has a full address, and again every day until it succeeds."}
            </span>
          </form>
        )}
      </section>
      <StoreForm mode="edit" store={store} />
      <div className="mt-8">
        <InviteOwnerForm storeId={store.id} />
      </div>
    </div>
  );
}
