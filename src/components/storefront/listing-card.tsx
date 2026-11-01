import Link from "next/link";
import type { StorefrontListing } from "@/lib/storefront/service";
import { PriceDisplay } from "./price-display";
import { StockBadgeChip } from "./stock-badge";
import { QuickAddStepper } from "./quick-add-stepper";
import { ProductImage } from "./product-image";

export function ListingCard({
  listing,
}: {
  listing: StorefrontListing;
  categorySlug?: string;
}) {
  return (
    <article className="sf-product-card" data-testid="listing-card">
      <div className="sf-product-photo">
        <Link
          href={`/listings/${listing.id}`}
          aria-label={`View ${listing.displayName}`}
          tabIndex={-1}
        >
          <ProductImage src={listing.imageUrl} name={listing.displayName} />
        </Link>
        {listing.frozen && <span className="sf-photo-tag">Frozen</span>}
        <div className="sf-quick-add">
          <QuickAddStepper
            item={{
              listingId: listing.id,
              variantId: listing.variantId,
              name: listing.displayName,
              price: listing.startingPrice,
              imageUrl: listing.imageUrl,
              packLabel: listing.packLabel,
            }}
            disabled={listing.badge === "ask-store"}
          />
        </div>
      </div>
      <div className="sf-product-copy">
        <PriceDisplay cents={listing.startingPrice} weightG={listing.weightG} />
        <Link href={`/listings/${listing.id}`} className="sf-product-name">
          {listing.displayName}
        </Link>
        {listing.altName && <p className="sf-local-name">{listing.altName}</p>}
        <div className="sf-product-meta">
          <span>{listing.packLabel ?? "Each"}</span>
          <StockBadgeChip badge={listing.badge} />
        </div>
      </div>
    </article>
  );
}
