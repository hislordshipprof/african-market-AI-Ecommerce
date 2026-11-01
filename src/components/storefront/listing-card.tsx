"use client";
import Link from "next/link";
import { useId, useRef, ViewTransition } from "react";
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
  const ref = useRef<HTMLElement>(null);
  const instance = useId();
  const { selected, select } = useProductImageTransition();
  const openQuickView = useQuickView();
  const choose = () => flushSync(() => select(instance));
  return (
    <article ref={ref} className="sf-product-card" data-testid="listing-card"
      onPointerMove={e => {
        if (e.pointerType !== "mouse" || !window.matchMedia("(hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference)").matches) return;
        const box = e.currentTarget.getBoundingClientRect();
        const x = Math.max(-6, Math.min(6, (e.clientY - box.top) / box.height * -12 + 6));
        const y = Math.max(-6, Math.min(6, (e.clientX - box.left) / box.width * 12 - 6));
        e.currentTarget.style.setProperty("--tilt-x", `${x}deg`);
        e.currentTarget.style.setProperty("--tilt-y", `${y}deg`);
      }} onPointerLeave={() => { ref.current?.style.setProperty("--tilt-x", "0deg"); ref.current?.style.setProperty("--tilt-y", "0deg"); }}>
      <div className="sf-product-photo">
        <Link
          href={`/listings/${listing.id}`}
          aria-label={`View ${listing.displayName}`}
          tabIndex={-1}
          onNavigate={choose}
        >
          <ViewTransition name={selected === instance ? `product-${listing.id}` : "auto"} share="sf-product-morph" default="none"><ProductImage src={listing.imageUrl} name={listing.displayName} /></ViewTransition>
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
            }}
            disabled={listing.badge === "ask-store"}
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
