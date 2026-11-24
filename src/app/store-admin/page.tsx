import { headers } from "next/headers";
import { requireStoreMember } from "@/lib/store-admin/session";
import { storeWebAddress } from "@/lib/directory/links";
import { storeUnreadCount } from "@/lib/support/thread";
import { getStoreBilling } from "@/lib/billing/service";
import { assistantChatUsage } from "@/lib/billing/assistant-chats";
import { PLAN_NAMES, planAllows } from "@/lib/billing/plan";
import { directoryOrderCount } from "@/lib/directory/directory-orders";
import { goLiveItemLabel, readGoLiveChecklist, type GoLiveItemKey } from "@/lib/go-live/checklist";
import type { GoLiveItemView } from "@/components/go-live/go-live-items";
import { StoreAdminDashboard } from "./dashboard";

async function goLiveItems(storeId: string, storeSlug: string, isOwner: boolean): Promise<GoLiveItemView[] | null> {
  const checklist = await readGoLiveChecklist(storeId, new Date());
  if (!checklist || checklist.status !== "setup") return null;
  const store = `?store=${encodeURIComponent(storeSlug)}`;
  const hrefs: Partial<Record<GoLiveItemKey, string>> = {
    listings: `/store-admin/listings${store}`,
    weights: `/store-admin/listings${store}`,
    ...(isOwner
      ? {
          payouts: `/store-admin/payouts${store}`,
          plan: `/store-admin/plan${store}`,
          hours: `/store-admin/settings${store}`,
          fulfillment: `/store-admin/settings${store}`,
        }
      : {}),
  };
  return checklist.items.map((item) => ({
    key: item.key,
    label: goLiveItemLabel(item.key, checklist.floor),
    detail: item.detail,
    done: item.done,
    href: hrefs[item.key],
  }));
}

export default async function StoreAdminPage() {
  const session = await requireStoreMember();
  const [unreadMessages, billing, directoryOrders] = await Promise.all([
    storeUnreadCount(session.store.id),
    getStoreBilling(session.store.id),
    directoryOrderCount(session.store.id),
  ]);
  const isOwner = session.membership.role === "owner";
  const usage = isOwner ? await assistantChatUsage(session.store.id, billing.plan) : null;
  const goLive = session.store.status === "setup" ? await goLiveItems(session.store.id, session.store.slug, isOwner) : null;
  const host = (await headers()).get("host");

  return (
    <StoreAdminDashboard
      storeName={session.store.name}
      storeSlug={session.store.slug}
      userName={session.user.name ?? session.user.email}
      role={session.membership.role}
      stripeOnboardingStatus={session.store.stripeOnboardingStatus}
      unreadMessages={unreadMessages}
      directoryOrders={directoryOrders}
      goLive={goLive}
      storeAddress={host ? storeWebAddress(session.store.slug, host) : null}
      minimumOrderCents={session.store.minimumOrderCents}
      located={session.store.lat != null && session.store.lng != null}
      plan={{
        name: PLAN_NAMES[billing.plan],
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
