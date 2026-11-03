import { requireStoreMember } from "@/lib/store-admin/session";
import { getStoreOrders } from "@/lib/order/service";
import { platform } from "@/lib/db";
import { OrderInbox } from "./order-inbox";

export default async function OrdersPage() {
  const session = await requireStoreMember();
  const orders = await getStoreOrders(session.store.id);

  if (process.env.E2E_FAKE_STRIPE === "1" && !process.env.VERCEL) {
    const { ensureAuthorizedAmount } = await import("@/lib/stripe/fake");
    for (const order of orders) {
      if (order.paymentIntentId) {
        ensureAuthorizedAmount(order.paymentIntentId, order.totalAuthorizedCents);
      }
    }
  }

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
