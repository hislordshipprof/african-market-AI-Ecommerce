"use client";
import { useState, ViewTransition } from "react";
import type { StorefrontListingDetail } from "@/lib/storefront/service";
import { formatPrice, formatWeight } from "@/lib/format";
import { ProductImage } from "./product-image";
import { PriceDisplay } from "./price-display";
import { StockBadgeChip } from "./stock-badge";
import { QuickAddStepper } from "./quick-add-stepper";
import { AssistantSlot } from "./assistant/assistant-slot";
export function ProductDetail({
  listing,
  servingSuggestion,
}: {
  listing: StorefrontListingDetail;
  servingSuggestion: boolean;
}) {
  const [variantId, setVariantId] = useState(listing.variants[0]?.id);
  const variant = listing.variants.find((v) => v.id === variantId);
  const price = variant?.price ?? listing.price;
  const item = {
    listingId: listing.id,
    variantId: variant?.id,
    name: listing.displayName,
    price,
    imageUrl: listing.imageUrl,
    packLabel: variant?.label ?? "Each",
  };
  return (
    <div className="sf-detail" data-testid="product-detail">
      <div className="sf-detail-photo">
        <ViewTransition name={`product-${listing.id}`} share="sf-product-morph" default="none"><ProductImage category={listing.categorySlug}
          src={listing.imageUrl}
          name={listing.displayName}
          sizes="(max-width:767px) 92vw, 45vw"
          priority
        /></ViewTransition>
        <p className="sf-photo-note">
          {servingSuggestion
            ? "Serving suggestion. "
            : "Representative product photo. "}
          Packaging and appearance may vary; check the pack for details.
        </p>
      </div>
      <div className="sf-detail-copy">
        <StockBadgeChip badge={listing.badge} />
        <h2 className="sf-page-title">{listing.displayName}</h2>
        {listing.altName && <p>{listing.altName}</p>}
        <PriceDisplay
          cents={price}
          weightG={variant?.weightG}
          unit={variant?.label ?? "item"}
        />
        {listing.variants.length > 0 && (
          <section className="sf-variants" aria-labelledby="variants-heading">
            <h3 id="variants-heading">Available sizes</h3>
            <ul>
              {listing.variants.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    data-testid="pack-option"
                    aria-pressed={variantId === v.id}
                    onClick={() => setVariantId(v.id)}
                  >
                    {v.label}
                    <small>
                      {formatWeight(v.weightG)} / {formatPrice(v.price)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <dl className="sf-stats">
          <div>
            <dt>Origin</dt>
            <dd>See packaging</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{variant ? formatWeight(variant.weightG) : "See packaging"}</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>
              {listing.frozen
                ? "Keep frozen"
                : listing.perishable
                  ? "Refrigerate"
                  : "Ambient"}
            </dd>
          </div>
        </dl>
        <section className="sf-detail-description">
          <h3>About this product</h3>
          <p>
            {listing.description ??
              "A staple from your local market. Check the product packaging for ingredients, allergens and preparation instructions."}
          </p>
        </section>
        <AssistantSlot label="Ask AI about this item" />
        <div className="sf-add-bar">
          <div>
            <span>{variant?.label ?? "Each"}</span>
            <PriceDisplay cents={price} weightG={variant?.weightG} />
          </div>
          {listing.badge === "ask-store" ? (
            <span>Ask the store about availability</span>
          ) : (
            <>
              <span>Add to your basket</span>
              <QuickAddStepper item={item} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
