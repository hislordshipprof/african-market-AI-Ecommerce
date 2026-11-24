import { requireStoreMember } from "@/lib/store-admin/session";
import { listListings } from "@/lib/listing/service";
import { platform } from "@/lib/db";
import { ListingManagement } from "./listing-management";

/** Every member sees Products; staff only update stock, and the server actions hold to that (#784). */
export default async function ListingsPage() {
  const session = await requireStoreMember();
  const [listings, aisles] = await Promise.all([
    listListings(session.store.id, true),
    platform.category.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <ListingManagement
      storeName={session.store.name}
      storeSlug={session.store.slug}
      storeShips={session.store.shippingHandlingDays != null}
      aisles={aisles}
      canManage={session.membership.role === "owner"}
      canEditStock={!session.membership.readOnly}
      listings={listings.map((l) => ({
        id: l.id,
        masterProductId: l.masterProductId,
        categoryId: l.categoryId,
        customName: l.customName,
        masterProductName: l.masterProduct?.name ?? null,
        price: l.price,
        stockMode: l.stockMode,
        qty: l.qty,
        status: l.status,
        frozen: l.frozen,
        perishable: l.perishable,
        shippable: l.shippable,
        prepared: l.prepared,
        prepMinutes: l.prepMinutes,
        cateringLeadHours: l.cateringLeadHours,
        cateringMinQty: l.cateringMinQty,
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
