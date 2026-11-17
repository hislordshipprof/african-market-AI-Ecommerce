"use client";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./use-reduced-motion";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { StorefrontListing, StorefrontListingDetail } from "@/lib/storefront/service";
import { Sheet } from "./sheet";
import { ProductImage } from "./product-image";
import { PriceDisplay } from "./price-display";
import { formatPrice } from "@/lib/format";
import { QuickAddStepper } from "./quick-add-stepper";
import { CartAnnouncement } from "./cart-provider";
import { selectQuickViewPack, type QuickViewDetailState } from "./quick-view-selection";

export function QuickView({ listing, onClose }: { listing: StorefrontListing; onClose: () => void }) {
  const [detail, setDetail] = useState<StorefrontListingDetail | null>(null);
  const [error, setError] = useState(false);
  // Bumped by Retry, so a failed detail load can be asked again in place (#708 P2).
  const [attempt, setAttempt] = useState(0);
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
  }, [listing.id, attempt]);

  const detailState: QuickViewDetailState = error
    ? { status: "error" }
    : detail
      ? { status: "loaded", packs: detail.variants, basePrice: detail.price, badge: detail.badge }
      : { status: "loading" };
  const selection = selectQuickViewPack({
    listingId: listing.id,
    name: listing.displayName,
    imageUrl: listing.imageUrl,
    // The fetched detail is fresher than the card's copy of the listing.
    maxPerOrder: detail?.maxPerOrder ?? listing.maxPerOrder,
    listPacks: listing.packOptions ?? [],
    listBasePrice: listing.startingPrice,
    defaultVariantId: listing.variantId,
    chosenVariantId,
    detail: detailState,
  });

  return (
    <Sheet open={open} onClose={close} title={`Quick view: ${listing.displayName}`}>
      {/* The page's cart status is inert behind this modal, so the add is announced here. */}
      <CartAnnouncement />
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
        {/* Identity, price, then pack choice, then add (#708 P2). */}
        <p>{detail?.description ?? "A familiar favorite from your neighborhood shelves."}</p>
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
        {selection.statusMessage && (
          <div className="sf-quick-status-row">
            <p className="sf-quick-status" role="status">
              {selection.statusMessage}
            </p>
            {error && (
              <button
                type="button"
                className="sf-chip"
                onClick={() => {
                  setError(false);
                  setDetail(null);
                  setAttempt((value) => value + 1);
                }}
              >
                Retry
              </button>
            )}
          </div>
        )}
        <div className="sf-quick-view-add">
          <span className="sf-quick-view-choice">
            {selection.heading}
            {/* The chosen pack and its price, beside the control that adds it. */}
            {!selection.addDisabled && !selection.addBlockedReason && (
              <small>
                {selection.cartItem.packLabel ?? "Each"} · {formatPrice(selection.price)}
              </small>
            )}
          </span>
          <QuickAddStepper
            disabled={selection.addDisabled}
            blockedReason={selection.addBlockedReason}
            item={selection.cartItem}
          />
        </div>
        <Link className="sf-text-link" href={`/listings/${listing.id}`} onClick={onClose}>
          See full product details <ArrowRight size={16} aria-hidden />
        </Link>
      </div>
    </Sheet>
  );
}
