"use client";
import { useState, ViewTransition } from "react";
import type { ListingFacts, StorefrontListingDetail } from "@/lib/storefront/service";
import { formatWeight, money } from "@/lib/format";
import { attributeLabel } from "@/lib/catalog/attributes";
import { cateringLeadText } from "@/lib/listing/catering";
import { ProductImage } from "./product-image";
import { PriceDisplay } from "./price-display";
import { StockBadgeChip } from "./stock-badge";
import { QuickAddStepper } from "./quick-add-stepper";
import { AssistantSlot } from "./assistant/assistant-slot";
export function ProductDetail({
  listing,
  facts,
  servingSuggestion,
}: {
  listing: StorefrontListingDetail;
  /** Read fresh, outside the storefront cache (#808). */
  facts: ListingFacts | null;
  servingSuggestion: boolean;
}) {
  const stockLeft = facts?.stockLeft;
  const minQty = listing.catering?.minQty;
  const [variantId, setVariantId] = useState(listing.variants[0]?.id);
  const variant = listing.variants.find((v) => v.id === variantId);
  const price = variant?.price ?? listing.price;
  // A pack with no known weight is priced per item (#752).
  const unit = variant && variant.weightG !== undefined ? variant.label : "item";
  const item = {
    listingId: listing.id,
    variantId: variant?.id,
    name: listing.displayName,
    price,
    imageUrl: listing.imageUrl,
    categorySlug: listing.categorySlug,
    packLabel: variant?.label ?? "Each",
    maxPerOrder: listing.maxPerOrder,
    stockLeft,
    cateringMinQty: minQty,
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
        <StockBadgeChip badge={listing.badge} stockLeft={stockLeft} />
        <h1 className="sf-page-title">{listing.displayName}</h1>
        {listing.altName && <p>{listing.altName}</p>}
        <PriceDisplay
          cents={price}
          weightG={variant?.weightG}
          unit={unit}
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
                      {v.weightG ? `${formatWeight(v.weightG)} / ` : ""}{money(v.price)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {/* After the pack choice, carrying that pack and its price (#708 P2); phones pin it to the bottom. */}
        <div className="sf-add-bar">
          <div>
            <span>{variant?.label ?? "Each"}</span>
            <PriceDisplay cents={price} weightG={variant?.weightG} unit={unit} />
          </div>
          {listing.badge === "ask-store" ? (
            <span>Ask the store about availability</span>
          ) : (
            <>
              <span>{minQty && minQty > 1 ? `Adds ${minQty}, the minimum` : "Add to your basket"}</span>
              <QuickAddStepper item={item} />
            </>
          )}
        </div>
        <dl className="sf-stats">
          <div>
            <dt>Size</dt>
            <dd>{variant?.weightG ? formatWeight(variant.weightG) : "See packaging"}</dd>
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
          {listing.catering && (
            <div>
              <dt>Catering</dt>
              <dd data-testid="catering-terms">
                Order {cateringLeadText(listing.catering.leadHours)} ahead · minimum {listing.catering.minQty}
              </dd>
            </div>
          )}
          {facts?.allergens && (
            <div>
              <dt>Allergens</dt>
              <dd data-testid="allergens">
                {facts.allergens.length
                  ? `Contains ${facts.allergens.map((value) => attributeLabel(value).toLowerCase()).join(", ")}`
                  : "None of the 9 major allergens"}
              </dd>
            </div>
          )}
          {facts?.dietary && facts.dietary.length > 0 && (
            <div>
              <dt>Dietary</dt>
              <dd data-testid="dietary-claims">{facts.dietary.map(attributeLabel).join(", ")}</dd>
            </div>
          )}
        </dl>
        <section className="sf-detail-description">
          <h3>About this product</h3>
          <p>
            {listing.description ??
              "A staple from your local market. Check the product packaging for ingredients, allergens and preparation instructions."}
          </p>
        </section>
        <AssistantSlot label="Ask AI about this item" />
      </div>
    </div>
  );
}
