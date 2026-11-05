import { requireStoreMember } from "@/lib/store-admin/session";
import { getStoreOrders } from "@/lib/order/service";
import { platform } from "@/lib/db";
import { OrderInbox } from "./order-inbox";

export default async function OrdersPage() {
  const session = await requireStoreMember();
  const orders = await getStoreOrders(session.store.id);

  const store = await platform.store.findUnique({
    where: { id: session.store.id },
    select: {
      autoAcceptOrders: true,
      prepTimeMinutes: true,
    },
  });

  return (
    <OrderInbox
      initialOrders={orders}
      storeName={session.store.name}
      storeSlug={session.store.slug}
      autoAcceptOrders={store?.autoAcceptOrders ?? false}
      defaultPrepMinutes={store?.prepTimeMinutes ?? 30}
    />
  );
}
