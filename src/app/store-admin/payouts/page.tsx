import { requireStoreOwner } from "@/lib/store-admin/session";
import { PayoutsSettings } from "./payouts-settings";
import { PayoutList } from "./payout-list";

export default async function PayoutsPage({ searchParams }: { searchParams: Promise<{ dashboard?: string }> }) {
  const [session, params] = await Promise.all([requireStoreOwner(), searchParams]);

  return (
    <PayoutsSettings
      storeName={session.store.name}
      storeSlug={session.store.slug}
      stripeOnboardingStatus={session.store.stripeOnboardingStatus}
      hasStripeAccount={!!session.store.stripeAccountId}
    >
      <PayoutList store={session.store} dashboardFailed={params.dashboard === "failed"} />
    </PayoutsSettings>
  );
}
