import Link from "next/link";
import { notFound } from "next/navigation";
import { getStore } from "@/lib/get-store";
import { getListingDetail, listingsByCategory } from "@/lib/storefront/service";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { ProductDetail } from "@/components/storefront/product-detail";
import { ProductRail } from "@/components/storefront/product-rail";
export default async function ListingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, store] = await Promise.all([params, getStore()]);
  const listing = await getListingDetail(store.id, id);
  if (!listing) notFound();
  const related = listing.categorySlug
    ? await listingsByCategory(store.id, listing.categorySlug)
    : null;
  return (
    <StorefrontShell store={store}>
      <div className="sf-container sf-detail-page">
        <nav className="sf-breadcrumb" aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span aria-hidden>/</span>
          <Link href="/categories">Categories</Link>
          {related?.category && (
            <>
              <span aria-hidden>/</span>
              <Link href={`/categories/${related.category.slug}`}>
                {related.category.name}
              </Link>
            </>
          )}
          <span aria-hidden>/</span>
          <span>{listing.displayName}</span>
        </nav>
        <ProductDetail
          listing={listing}
          servingSuggestion={/soup|Swallow|puff-puff|Suya_with/i.test(
            listing.imageUrl ?? "",
          )}
        />
        {related && (
          <div className="sf-section">
            <ProductRail
              title="Often bought with"
              listings={related.listings.filter((l) => l.id !== id).slice(0, 8)}
              seeAllHref={`/categories/${listing.categorySlug}`}
            />
          </div>
        )}
      </div>
    </StorefrontShell>
  );
}
