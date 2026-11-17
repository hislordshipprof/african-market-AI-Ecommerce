"use client";
import Link from "next/link";
import { useId, ViewTransition } from "react";
import { flushSync } from "react-dom";
import { useQuickView, useProductImageTransition } from "./quick-view-provider";
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
  const instance = useId();
  const { selected, select } = useProductImageTransition();
  const openQuickView = useQuickView();
  const choose = () => flushSync(() => select(instance));
  return (
    <article className="sf-product-card" data-testid="listing-card">
      <div className="sf-product-photo">
        <Link
          href={`/listings/${listing.id}`}
          aria-label={`View ${listing.displayName}`}
          tabIndex={-1}
          onNavigate={choose}
        >
          <ViewTransition name={selected === instance ? `product-${listing.id}` : "auto"} share="sf-product-morph" default="none"><ProductImage category={listing.categorySlug} src={listing.imageUrl} name={listing.displayName} /></ViewTransition>
        </Link>
        <button className="sf-quick-view-trigger" onClick={() => openQuickView(listing)} aria-label={`Quick view ${listing.displayName}`}>Quick view</button>
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
              maxPerOrder: listing.maxPerOrder,
            }}
            blockedReason={listing.badge === "ask-store" ? "Ask store first" : undefined}
          />
        </div>
      </div>
      <div className="sf-product-copy">
        <PriceDisplay cents={listing.startingPrice} weightG={listing.weightG} />
        <Link href={`/listings/${listing.id}`} className="sf-product-name" onNavigate={choose}>
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
