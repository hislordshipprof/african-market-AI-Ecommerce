import Link from "next/link";
import { Plus } from "lucide-react";
import type { StorefrontListing } from "@/lib/storefront/service";
import { PriceDisplay } from "./price-display";
import { StockBadgeChip } from "./stock-badge";

export function ListingCard({ listing }: { listing: StorefrontListing }) {
  return (
    <div
      className="group flex flex-col overflow-hidden rounded-md bg-surface transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
      style={{ transitionTimingFunction: "var(--ease-std)" }}
      data-testid="listing-card"
    >
      <div className="relative flex aspect-square w-full items-center justify-center bg-raised">
        <svg
          className="h-12 w-12 text-muted-foreground/20"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1}
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 10.5V6a3.75 3.75 0 1 0-7.5 0v4.5m11.356-1.993 1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 0 1-1.12-1.243l1.264-12A1.125 1.125 0 0 1 5.513 7.5h12.974c.576 0 1.059.435 1.119 1.007ZM8.625 10.5a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm7.5 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
          />
        </svg>

        <button
          type="button"
          data-testid="quick-add-btn"
          className="absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary text-on-primary shadow-sm transition-transform duration-150 hover:scale-110 active:scale-95"
          aria-label={`Add ${listing.displayName} to cart`}
        >
          <Plus className="h-5 w-5" />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-0.5 p-3">
        {listing.altName && (
          <span className="font-label text-[11px] uppercase tracking-wider text-muted-foreground">
            {listing.altName}
          </span>
        )}

        <Link
          href={`/listings/${listing.id}`}
          className="font-body text-sm font-medium leading-snug text-ink line-clamp-2 hover:text-primary"
        >
          {listing.displayName}
        </Link>

        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          <PriceDisplay
            cents={listing.startingPrice}
            className="font-body text-base font-semibold text-ink"
          />
          <StockBadgeChip badge={listing.badge} />
        </div>

        {listing.frozen && (
          <span className="font-label text-[11px] text-muted-foreground">
            Frozen
          </span>
        )}
      </div>
    </div>
  );
}
