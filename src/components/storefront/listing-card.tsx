import Image from "next/image";
import Link from "next/link";
import type { StorefrontListing } from "@/lib/storefront/service";
import { PriceDisplay } from "./price-display";
import { StockBadgeChip } from "./stock-badge";
import { QuickAddStepper } from "./quick-add-stepper";

export function ListingCard({
  listing,
  categorySlug,
}: {
  listing: StorefrontListing;
  categorySlug?: string;
}) {
  const placeholderSrc = categorySlug
    ? `/images/categories/${categorySlug}.svg`
    : "/images/product-placeholder.svg";

  return (
    <div
      className="group flex flex-col overflow-hidden rounded-md bg-surface transition-all duration-200 hover:-translate-y-0.5 hover:bg-raised"
      style={{ transitionTimingFunction: "var(--ease-std)" }}
      data-testid="listing-card"
    >
      <div className="relative flex aspect-square w-full items-center justify-center bg-raised">
        <Image
          src={placeholderSrc}
          alt=""
          width={120}
          height={120}
          className="h-16 w-16 object-contain opacity-30"
          aria-hidden="true"
        />

        <div className="absolute bottom-2 right-2">
          <QuickAddStepper productName={listing.displayName} />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-0.5 p-3">
        <Link
          href={`/listings/${listing.id}`}
          className="font-body text-sm font-medium leading-snug text-ink line-clamp-2 hover:text-primary"
        >
          {listing.displayName}
        </Link>
        {listing.altName && (
          <span className="font-label text-[13px] tracking-wider text-muted-foreground">
            {listing.altName}
          </span>
        )}

        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          <PriceDisplay
            cents={listing.startingPrice}
            className="font-body text-base font-semibold text-ink"
          />
          <StockBadgeChip badge={listing.badge} />
        </div>

        {listing.frozen && (
          <span className="font-label text-[13px] text-muted-foreground">
            Frozen
          </span>
        )}
      </div>
    </div>
  );
}
