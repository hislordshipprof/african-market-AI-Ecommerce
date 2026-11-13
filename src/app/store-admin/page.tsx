import { requireStoreMember } from "@/lib/store-admin/session";
import { storeUnreadCount } from "@/lib/support/thread";
import { getStoreBilling } from "@/lib/billing/service";
import { assistantChatUsage } from "@/lib/billing/assistant-chats";
import { planAllows } from "@/lib/billing/plan";
import { StoreAdminDashboard } from "./dashboard";

export default async function StoreAdminPage() {
  const session = await requireStoreMember();
  const [unreadMessages, billing] = await Promise.all([
    storeUnreadCount(session.store.id),
    getStoreBilling(session.store.id),
  ]);
  const usage = session.membership.role === "owner" ? await assistantChatUsage(session.store.id, billing.plan) : null;

  return (
    <StoreAdminDashboard
      storeName={session.store.name}
      storeSlug={session.store.slug}
      userName={session.user.name ?? session.user.email}
      role={session.membership.role}
      stripeOnboardingStatus={session.store.stripeOnboardingStatus}
      unreadMessages={unreadMessages}
      plan={{
        name: billing.plan === "pro" ? "Pro" : "Starter",
        status: billing.status,
        paymentFailed: billing.paymentFailedAt !== null,
        chats: usage && usage.warning ? { used: usage.chats, cap: usage.cap, capped: usage.capped } : null,
        readOnly: session.membership.readOnly,
        reportsAllowed: planAllows(billing.plan, "copilot-reports"),
        analyticsAllowed: planAllows(billing.plan, "analytics-dashboard"),
        ownDomainAllowed: planAllows(billing.plan, "own-domain"),
      }}
    />
  );
}
