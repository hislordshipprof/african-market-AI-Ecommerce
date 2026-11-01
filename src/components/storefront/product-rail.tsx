import type { StorefrontListing } from "@/lib/storefront/service";
import { ProductListMotion } from "./product-list-motion";
import { ListingCard } from "./listing-card";
import { RailScroller } from "./rail-scroller";
export function ProductRail({
  title,
  listings,
  seeAllHref,
  description,
}: {
  title: string;
  categorySlug?: string;
  listings: StorefrontListing[];
  seeAllHref?: string;
  description?: string;
}) {
  if (!listings.length) return null;
  return (
    <section data-testid="product-rail" aria-label={title}>
      <RailScroller
        label={title}
        title={title}
        description={description}
        href={seeAllHref}
      >
        <ProductListMotion contents itemClassName="sf-rail-item">
          {listings.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </ProductListMotion>
      </RailScroller>
    </section>
  );
}
