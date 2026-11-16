import { requireStoreOwner } from "@/lib/store-admin/session";
import { platform, storeScoped } from "@/lib/db";
import { readShippingStates } from "@/lib/shipping/settings";
import { ShippingForm } from "./shipping-form";

export const dynamic = "force-dynamic";

export default async function StoreShippingPage() {
  const { store } = await requireStoreOwner();
  // Fresh, not the cached store row: the form must show what was last saved.
  const [row, states, shippableListings] = await Promise.all([
    platform.store.findUnique({ where: { id: store.id }, select: { shippingHandlingDays: true } }),
    readShippingStates(),
    storeScoped(store.id).listing.count({ where: { storeId: store.id, active: true, shippable: true } }),
  ]);
  return (
    <ShippingForm
      storeName={store.name}
      storeSlug={store.slug}
      initialHandlingDays={row?.shippingHandlingDays ?? null}
      states={states}
      shippableListings={shippableListings}
      located={Boolean(store.addressLine1 && store.city && store.state && store.zip && store.lat != null && store.lng != null)}
    />
  );
}
