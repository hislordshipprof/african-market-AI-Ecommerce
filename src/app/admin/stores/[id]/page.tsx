import { notFound } from "next/navigation";
import { getStoreById, getStoreSubscription, setPilotAction } from "@/lib/admin/actions";
import { effectivePlan } from "@/lib/billing/plan";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { StoreForm } from "../store-form";
import { InviteOwnerForm } from "./invite-owner-form";

export default async function EditStorePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pilotError?: string }>;
}) {
  await requirePlatformAdmin();
  const { id } = await params;
  const { pilotError } = await searchParams;
  const store = await getStoreById(id);
  if (!store) notFound();
  const subscription = await getStoreSubscription(store.id);
  const plan = effectivePlan(subscription) === "pro" ? "Pro" : "Starter";

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
            {subscription?.pilot ? "Remove pilot offer" : "Make a pilot store (3 months free)"}
          </button>
          <span className="text-sm text-[#55625A]">
            {subscription?.pilot ? "This store is a pilot store." : "Up to 5 pilot stores."}
          </span>
        </form>
        {pilotError && (
          <p role="alert" className="mt-2 text-sm text-red-700">{pilotError}</p>
        )}
      </section>
      <StoreForm mode="edit" store={store} />
      <div className="mt-8">
        <InviteOwnerForm storeId={store.id} />
      </div>
    </div>
  );
}
