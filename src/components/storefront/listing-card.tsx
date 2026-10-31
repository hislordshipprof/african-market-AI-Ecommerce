import Link from "next/link";
import type { StorefrontListing } from "@/lib/storefront/service";
import { formatPrice } from "@/lib/format";
import { StockBadgeChip } from "./stock-badge";

export function ListingCard({ listing }: { listing: StorefrontListing }) {
  return (
    <Link
      href={`/listings/${listing.id}`}
      className="group flex flex-col overflow-hidden rounded-md bg-surface transition-shadow hover:shadow-sm"
    >
      <div className="aspect-square w-full bg-raised" />

      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="font-body text-sm font-medium leading-snug text-ink line-clamp-2 group-hover:text-primary">
          {listing.displayName}
        </h3>

        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          <span className="font-body text-base font-semibold text-ink">
            {formatPrice(listing.startingPrice)}
          </span>
          <StockBadgeChip badge={listing.badge} />
        </div>

        {listing.frozen && (
          <span className="font-label text-xs text-muted-foreground">Frozen</span>
        )}
      </div>
    </Link>
  );
}
