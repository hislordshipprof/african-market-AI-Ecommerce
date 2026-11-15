import type { StorefrontListing } from "@/lib/storefront/service";
import type { CSSProperties } from "react";
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
        {/* Same markup ProductListMotion gave, without the animation library: a rail's cards never change in place (#563). */}
        <div style={{ display: "contents" }}>
          {listings.map((listing, index) => (
            <div key={listing.id} className="sf-rail-item" data-sf-reveal style={{ "--sf-reveal-delay": `${Math.min(index, 7) * 30}ms` } as CSSProperties}>
              <ListingCard listing={listing} />
            </div>
          ))}
        </div>
      </RailScroller>
    </section></SectionReveal>
  );
}
