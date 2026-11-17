import { requireStoreOwner } from "@/lib/store-admin/session";
import { storeScoped } from "@/lib/db";
import { storeMayUse } from "@/lib/billing/plan";
import { listActiveListings } from "@/lib/purchasing/listings";
import { listPurchaseOrders } from "@/lib/purchasing/purchase-orders";
import { listSuppliers } from "@/lib/purchasing/suppliers";
import { PlanLocked } from "@/components/store-admin/plan-locked";
import { PurchaseOrdersPage } from "./purchase-orders-panel";

export const dynamic = "force-dynamic";

export default async function StorePurchaseOrdersPage() {
  const { store } = await requireStoreOwner();
  if (!(await storeMayUse(store.id, "reorder-suggestions"))) {
    return (
      <PurchaseOrdersPage storeName={store.name} storeSlug={store.slug} locked={
        <PlanLocked
          title="Suppliers and purchase orders"
          description="Turn your reorder list into one order per wholesaler and send it by email, WhatsApp or text."
          storeSlug={store.slug}
        />
      } />
    );
  }
  const [suppliers, orders, listings, list] = await Promise.all([
    listSuppliers(store.id),
    listPurchaseOrders(store.id),
    listActiveListings(store.id),
    storeScoped(store.id).reorderList.findUnique({ where: { storeId: store.id }, select: { updatedAt: true } }),
  ]);
  return (
    <PurchaseOrdersPage
      storeName={store.name}
      storeSlug={store.slug}
      suppliers={suppliers}
      orders={orders.map((order) => ({ ...order, sentAt: order.sentAt?.toISOString() ?? null, createdAt: order.createdAt.toISOString() }))}
      listings={listings}
      listSavedAt={list?.updatedAt.toISOString() ?? null}
    />
  );
}
