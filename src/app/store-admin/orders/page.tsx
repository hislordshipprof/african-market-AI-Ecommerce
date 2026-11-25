import { redirect } from "next/navigation";
import { requireStoreMember } from "@/lib/store-admin/session";
import { getStoreOrders } from "@/lib/order/service";
import { issuesToReview } from "@/lib/order/issue-review";
import { platform } from "@/lib/db";
import { vapidPublicKey } from "@/lib/push/sender";
import { OrderInbox } from "./order-inbox";
import { ProblemsToReview } from "./problems-to-review";
import { DriverRoutes } from "./driver-routes";
import { driverRouteBoard } from "@/lib/delivery/driver-route";
import { newOrderEmailOn } from "@/lib/email/new-order-owner";

/** The Orders page; with an id, that order's panel is open (/store-admin/orders/[id], #860). */
export async function OrdersView({ selectedId }: { selectedId?: string }) {
  const session = await requireStoreMember();
  const owner = session.membership.role === "owner";
  const [orders, issues, store, routeSlots, newOrderEmail] = await Promise.all([
    getStoreOrders(session.store.id),
    issuesToReview(session.store.id),
    platform.store.findUnique({
      where: { id: session.store.id },
      select: {
        autoAcceptOrders: true,
        prepTimeMinutes: true,
      },
    }),
    driverRouteBoard(session.store.id, session.store.timezone),
    owner ? newOrderEmailOn(session.store.id, session.user.id) : null,
  ]);
  // An order that has left the inbox is shown with the past orders.
  if (selectedId && !orders.some((order) => order.id === selectedId)) {
    redirect(`/store-admin/orders/past/${encodeURIComponent(selectedId)}?store=${encodeURIComponent(session.store.slug)}`);
  }

  return (
    <OrderInbox
      initialOrders={orders}
      storeSlug={session.store.slug}
      vapidPublicKey={vapidPublicKey()}
      autoAcceptOrders={store?.autoAcceptOrders ?? false}
      defaultPrepMinutes={store?.prepTimeMinutes ?? 30}
      timeZone={session.store.timezone}
      newOrderEmail={newOrderEmail}
      isOwner={owner}
      initialSelectedId={selectedId ?? null}
      problems={(
        <>
          <ProblemsToReview issues={issues} timeZone={session.store.timezone} />
          <DriverRoutes initialSlots={routeSlots} />
        </>
      )}
    />
  );
}

export default function OrdersPage() {
  return <OrdersView />;
}
