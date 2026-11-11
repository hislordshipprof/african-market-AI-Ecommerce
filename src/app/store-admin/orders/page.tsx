import { requireStoreMember } from "@/lib/store-admin/session";
import { getStoreOrders } from "@/lib/order/service";
import { issuesToReview } from "@/lib/order/issue-review";
import { platform } from "@/lib/db";
import { vapidPublicKey } from "@/lib/push/sender";
import { OrderInbox } from "./order-inbox";
import { ProblemsToReview } from "./problems-to-review";

export default async function OrdersPage() {
  const session = await requireStoreMember();
  const [orders, issues, store] = await Promise.all([
    getStoreOrders(session.store.id),
    issuesToReview(session.store.id),
    platform.store.findUnique({
      where: { id: session.store.id },
      select: {
        autoAcceptOrders: true,
        prepTimeMinutes: true,
      },
    }),
  ]);

  return (
    <OrderInbox
      initialOrders={orders}
      storeName={session.store.name}
      storeSlug={session.store.slug}
      vapidPublicKey={vapidPublicKey()}
      autoAcceptOrders={store?.autoAcceptOrders ?? false}
      defaultPrepMinutes={store?.prepTimeMinutes ?? 30}
      problems={<ProblemsToReview issues={issues} />}
    />
  );
}
