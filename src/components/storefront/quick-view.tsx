"use client";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import Link from "next/link";
import type { StorefrontListing, StorefrontListingDetail } from "@/lib/storefront/service";
import { Sheet } from "./sheet";
import { ProductImage } from "./product-image";
import { PriceDisplay } from "./price-display";
import { QuickAddStepper } from "./quick-add-stepper";
export function QuickView({ listing, onClose }: { listing: StorefrontListing; onClose: () => void }) {
  const [detail, setDetail] = useState<StorefrontListingDetail | null>(null);
  const [error, setError] = useState(false);
  const [variantId, setVariantId] = useState(listing.variantId);
  const [zoom, setZoom] = useState(false);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => { cancelAnimationFrame(frame); if (closeTimer.current) clearTimeout(closeTimer.current); };
  }, []);
  const close = () => { setOpen(false); closeTimer.current = setTimeout(onClose, reduced ? 0 : 220); };
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/storefront/listings/${encodeURIComponent(listing.id)}`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error("Unavailable"); return r.json(); })
      .then(setDetail).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [listing.id]);
  const options = detail?.variants ?? listing.packOptions ?? [];
  const selected = options.find(v => v.id === variantId) ?? options[0];
  const price = selected?.price ?? detail?.price ?? listing.startingPrice;
  return <Sheet open={open} onClose={close} title={`Quick view: ${listing.displayName}`}>
    <div className="sf-quick-view" data-testid="quick-view">
      <button className="sf-quick-gallery" aria-label={zoom ? "Reset product image zoom" : "Zoom product image"} aria-pressed={zoom} onClick={() => setZoom(v => !v)} data-zoom={zoom}>
        <ProductImage src={detail?.imageUrl ?? listing.imageUrl} name={listing.displayName} sizes="(max-width:767px) 90vw, 430px" />
      </button>
      <p className="sf-local-name">{listing.altName}</p><p className="sf-photo-note">Representative ingredient. Packaging may vary.</p>
      <PriceDisplay cents={price} weightG={selected?.weightG} />
      {!!options.length && <fieldset className="sf-quick-packs"><legend>Choose pack size</legend>{options.map(v => <button className="sf-chip" key={v.id} aria-pressed={selected?.id === v.id} onClick={() => setVariantId(v.id)}>{v.label}</button>)}</fieldset>}
      <p>{detail?.description ?? "A familiar favorite from your neighborhood shelves."}</p>
      {error && <p role="status">Pack details could not load. Open the product page to try again.</p>}
      <div className="sf-quick-view-add"><span>{detail ? "Add to your basket" : error ? "Details unavailable" : "Loading pack sizes…"}</span><QuickAddStepper disabled={!detail || detail.badge === "ask-store"} item={{ listingId: listing.id, variantId: selected?.id, name: listing.displayName, price, imageUrl: listing.imageUrl, packLabel: selected?.label ?? "Each" }} /></div>
      <Link className="sf-text-link" href={`/listings/${listing.id}`} onClick={onClose}>See full product details →</Link>
    </div>
  </Sheet>;
}
