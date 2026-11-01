import type { StorefrontListing } from "@/lib/storefront/service";
import { RailScroller } from "./rail-scroller";
import { ListingCard } from "./listing-card";
import { SectionReveal } from "./scroll-motion";

export function DealsCarousel({ listings, demo }: { listings: StorefrontListing[]; demo: boolean }) {
  // Until the promotion adapter exists, percentage treatments are explicitly demo-only.
  if (!demo || !listings.length) return null;
  return <section className="sf-tinted-band sf-woven" data-testid="deals-carousel"><SectionReveal className="sf-container">
    <RailScroller className="sf-deals-rail" label="Demo deals" title="A little more for your basket." description="Sample offers · preview only. Displayed prices are the current demo prices.">
      {listings.slice(0, 8).map((listing, i) => <div className="sf-deal-card sf-rail-item" key={listing.id}>
        <span className="sf-deal-percent">{[10, 15, 20][i % 3]}%<small>sample offer</small></span><ListingCard listing={listing} />
      </div>)}
    </RailScroller>
  </SectionReveal></section>;
}
