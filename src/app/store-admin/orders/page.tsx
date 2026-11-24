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

export default async function OrdersPage() {
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

  return (
    <OrderInbox
      initialOrders={orders}
      storeName={session.store.name}
      storeSlug={session.store.slug}
      vapidPublicKey={vapidPublicKey()}
      autoAcceptOrders={store?.autoAcceptOrders ?? false}
      defaultPrepMinutes={store?.prepTimeMinutes ?? 30}
      timeZone={session.store.timezone}
      newOrderEmail={newOrderEmail}
      problems={(
        <>
          <ProblemsToReview issues={issues} timeZone={session.store.timezone} />
          <DriverRoutes initialSlots={routeSlots} />
        </>
      )}
    />
  );
}
