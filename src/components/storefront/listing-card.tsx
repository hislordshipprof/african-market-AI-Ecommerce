import Link from "next/link";
import type { StorefrontListing } from "@/lib/storefront/service";
import { PriceDisplay } from "./price-display";
import { StockBadgeChip } from "./stock-badge";

export function ListingCard({ listing }: { listing: StorefrontListing }) {
  return (
    <Link
      href={`/listings/${listing.id}`}
      className="group flex flex-col overflow-hidden rounded-md bg-surface transition-shadow hover:shadow-sm"
    >
      <div className="flex aspect-square w-full items-center justify-center bg-raised">
        <svg
          className="h-10 w-10 text-muted-foreground/30"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1}
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
        </svg>
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="font-body text-sm font-medium leading-snug text-ink line-clamp-2 group-hover:text-primary">
          {listing.displayName}
        </h3>
        {listing.altName && (
          <p className="font-label text-xs text-muted-foreground line-clamp-1">
            {listing.altName}
          </p>
        )}

        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          <PriceDisplay
            cents={listing.startingPrice}
            className="font-body text-base font-semibold text-ink"
          />
          <StockBadgeChip badge={listing.badge} />
        </div>

        {listing.frozen && (
          <span className="font-label text-xs text-muted-foreground">Frozen</span>
        )}
      </div>
    </Link>
  );
}
