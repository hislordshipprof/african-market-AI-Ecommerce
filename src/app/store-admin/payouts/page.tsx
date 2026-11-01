import { requireStoreOwner } from "@/lib/store-admin/session";
import { PayoutsSettings } from "./payouts-settings";

export default async function PayoutsPage() {
  const session = await requireStoreOwner();

  return (
    <PayoutsSettings
      storeName={session.store.name}
      storeSlug={session.store.slug}
      stripeOnboardingStatus={session.store.stripeOnboardingStatus}
      hasStripeAccount={!!session.store.stripeAccountId}
    />
  );
}
