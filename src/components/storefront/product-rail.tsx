import type { StorefrontListing } from "@/lib/storefront/service";
import { ProductListMotion } from "./product-list-motion";
import { ListingCard } from "./listing-card";
import { RailScroller } from "./rail-scroller";
import { SectionReveal } from "./scroll-motion";
export function ProductRail({
  title,
  listings,
  seeAllHref,
  seeAllLabel,
  description,
}: {
  title: string;
  categorySlug?: string;
  listings: StorefrontListing[];
  seeAllHref?: string;
  seeAllLabel?: string;
  description?: string;
}) {
  if (!listings.length) return null;
  return (
    <SectionReveal><section data-testid="product-rail" aria-label={title}>
      <RailScroller
        label={title}
        title={title}
        description={description}
        href={seeAllHref}
        hrefLabel={seeAllLabel}
      >
        <ProductListMotion contents itemClassName="sf-rail-item">
          {listings.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </ProductListMotion>
      </RailScroller>
    </section></SectionReveal>
  );
}
