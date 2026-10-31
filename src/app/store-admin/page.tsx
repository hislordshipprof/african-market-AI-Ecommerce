import { requireStoreMember } from "@/lib/store-admin/session";
import { StoreAdminDashboard } from "./dashboard";

export default async function StoreAdminPage() {
  const session = await requireStoreMember();

  return (
    <StoreAdminDashboard
      storeName={session.store.name}
      storeSlug={session.store.slug}
      userName={session.user.name ?? session.user.email}
      role={session.membership.role}
      stripeOnboardingStatus={session.store.stripeOnboardingStatus}
    />
  );
}
