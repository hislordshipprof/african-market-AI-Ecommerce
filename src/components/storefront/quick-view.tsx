"use client";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import Link from "next/link";
import type { StorefrontListing, StorefrontListingDetail } from "@/lib/storefront/service";
import { Sheet } from "./sheet";
import { ProductImage } from "./product-image";
import { PriceDisplay } from "./price-display";
import { QuickAddStepper } from "./quick-add-stepper";
import { selectQuickViewPack, type QuickViewDetailState } from "./quick-view-selection";

export function QuickView({ listing, onClose }: { listing: StorefrontListing; onClose: () => void }) {
  const [detail, setDetail] = useState<StorefrontListingDetail | null>(null);
  const [error, setError] = useState(false);
  const [chosenVariantId, setChosenVariantId] = useState<string | undefined>();
  const [zoom, setZoom] = useState(false);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => {
      cancelAnimationFrame(frame);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);
  const close = () => {
    setOpen(false);
    closeTimer.current = setTimeout(onClose, reduced ? 0 : 220);
  };
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetch(`/api/storefront/listings/${encodeURIComponent(listing.id)}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Unavailable");
        return response.json();
      })
      .then((payload: StorefrontListingDetail) => {
        if (active) setDetail(payload);
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setError(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [listing.id]);

  const detailState: QuickViewDetailState = error
    ? { status: "error" }
    : detail
      ? { status: "loaded", packs: detail.variants, basePrice: detail.price, badge: detail.badge }
      : { status: "loading" };
  const selection = selectQuickViewPack({
    listingId: listing.id,
    name: listing.displayName,
    imageUrl: listing.imageUrl,
    listPacks: listing.packOptions ?? [],
    listBasePrice: listing.startingPrice,
    defaultVariantId: listing.variantId,
    chosenVariantId,
    detail: detailState,
  });

  return (
    <Sheet open={open} onClose={close} title={`Quick view: ${listing.displayName}`}>
      <div className="sf-quick-view" data-testid="quick-view">
        <button
          type="button"
          className="sf-quick-gallery"
          aria-label={zoom ? "Reset product image zoom" : "Zoom product image"}
          aria-pressed={zoom}
          onClick={() => setZoom((value) => !value)}
          data-zoom={zoom}
        >
          <ProductImage
            category={detail?.categorySlug ?? listing.categorySlug}
            src={detail?.imageUrl ?? listing.imageUrl}
            name={listing.displayName}
            sizes="(max-width:767px) 90vw, 430px"
          />
        </button>
        <p className="sf-local-name">{listing.altName}</p>
        <p className="sf-photo-note">Representative ingredient. Packaging may vary.</p>
        <PriceDisplay cents={selection.price} weightG={selection.weightG} />
        {selection.options.length > 0 && (
          <fieldset className="sf-quick-packs">
            <legend>Choose pack size</legend>
            {selection.options.map((pack) => (
              <button
                type="button"
                className="sf-chip"
                key={pack.id}
                aria-pressed={selection.selectedId === pack.id}
                onClick={() => setChosenVariantId(pack.id)}
              >
                {pack.label}
              </button>
            ))}
          </fieldset>
        )}
        <p>{detail?.description ?? "A familiar favorite from your neighborhood shelves."}</p>
        {selection.statusMessage && (
          <p className="sf-quick-status" role="status">
            {selection.statusMessage}
          </p>
        )}
        <div className="sf-quick-view-add">
          <span>{selection.heading}</span>
          <QuickAddStepper disabled={selection.addDisabled} item={selection.cartItem} />
        </div>
        <Link className="sf-text-link" href={`/listings/${listing.id}`} onClick={onClose}>
          See full product details →
        </Link>
      </div>
    </Sheet>
  );
}
