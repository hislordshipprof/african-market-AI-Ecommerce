import { requireStoreMember } from "@/lib/store-admin/session";
import { getStoreOrders } from "@/lib/order/service";
import { issuesToReview } from "@/lib/order/issue-review";
import { platform } from "@/lib/db";
import { vapidPublicKey } from "@/lib/push/sender";
import { OrderInbox } from "./order-inbox";
import { ProblemsToReview } from "./problems-to-review";
import { DriverRoutes } from "./driver-routes";
import { driverRouteBoard } from "@/lib/delivery/driver-route";

export default async function OrdersPage() {
  const session = await requireStoreMember();
  const [orders, issues, store, routeSlots] = await Promise.all([
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
      problems={(
        <>
          <ProblemsToReview issues={issues} timeZone={session.store.timezone} />
          <DriverRoutes initialSlots={routeSlots} />
        </>
      )}
    />
  );
}
