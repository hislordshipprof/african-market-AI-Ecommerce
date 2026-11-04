import { requireStoreOwner } from "@/lib/store-admin/session";
import { listListings } from "@/lib/listing/service";
import { ListingManagement } from "./listing-management";

export default async function ListingsPage() {
  const session = await requireStoreOwner();
  const listings = await listListings(session.store.id, true);

  return (
    <ListingManagement
      storeName={session.store.name}
      storeSlug={session.store.slug}
      listings={listings.map((l) => ({
        id: l.id,
        masterProductId: l.masterProductId,
        customName: l.customName,
        masterProductName: l.masterProduct?.name ?? null,
        price: l.price,
        stockMode: l.stockMode,
        qty: l.qty,
        status: l.status,
        frozen: l.frozen,
        perishable: l.perishable,
        active: l.active,
        maxPerOrder: l.maxPerOrder,
        variants: l.variants.map((v) => ({
          id: v.id,
          label: v.label,
          price: v.price,
          weightG: v.weightG,
          weightPlaceholder: v.weightPlaceholder,
          sku: v.sku,
          barcode: v.barcode,
        })),
      }))}
    />
  );
}
