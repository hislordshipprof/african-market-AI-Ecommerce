import { getStoreWithStatus } from "@/lib/get-store";
import { checkCheckoutReady } from "@/lib/stripe/checkout-gate";
import {
  listCategories,
  getActiveBanners,
  getActiveCollections,
  getListingsByCategory,
  extractStoreProfile,
} from "@/lib/storefront/service";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { HeroCarousel } from "@/components/storefront/hero-carousel";
import { CategoryMosaic } from "@/components/storefront/category-mosaic";
import { ProductRail } from "@/components/storefront/product-rail";
import { CollectionBanners } from "@/components/storefront/collection-banner";
import { PromoBand } from "@/components/storefront/promo-band";
import { TrustStoryStrip } from "@/components/storefront/trust-story-strip";
import { EmptyState } from "@/components/storefront/primitives";
import { SectionReveal } from "@/components/storefront/scroll-motion";
import { MarketMarquee } from "@/components/storefront/marquee";
import { ReviewsCarousel } from "@/components/storefront/reviews-carousel";
import { demoFlowsEnabled } from "@/lib/customer-flow/demo-gate";

export default async function StorefrontPage() {
  const { store, suspended } = await getStoreWithStatus();
  const checkout = checkCheckoutReady(store.stripeOnboardingStatus);
  if (suspended)
    return (
      <main className="sf-storefront sf-section sf-container">
        <h1 className="sf-page-title">{store.name}</h1>
        <EmptyState
          title="We'll be back soon"
          description="This store is temporarily offline. Please check back later."
        />
      </main>
    );
  const [categories, banners, collections, rails] = await Promise.all([
    listCategories(),
    getActiveBanners(store.id),
    getActiveCollections(store.id),
    getListingsByCategory(store.id),
  ]);
  const all = rails.flatMap((r) => r.listings);
  const favorites = all
    .filter((l) => l.imageUrl && l.badge !== "ask-store" && !l.frozen)
    .slice(0, 10);
  const fresh = all.filter((l) => l.perishable && !l.frozen).slice(0, 10);
  const pantry = rails.find((r) => r.categorySlug === "grains-and-flours");
  const demo = demoFlowsEnabled(process.env) && ["mama-ngozi", "tante-marie"].includes(store.slug);
  const subjects = ["Plantain", "Scotch Bonnet Pepper", "Yam"].flatMap(name => all.filter(p => p.displayName === name)).slice(0, 3);
  return (
    <StorefrontShell store={store}>
      {!checkout.enabled && (
        <div className="sf-container" style={{ paddingBlock: "var(--sf-space-sm)" }}>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
            {checkout.message}
          </div>
        </div>
      )}
      <HeroCarousel banners={banners} products={subjects.length ? subjects : favorites.slice(0, 3)} pickupMinutes={store.prepTimeMinutes} pickupEnabled={store.pickupEnabled} />
      <MarketMarquee />
      <div className="sf-container sf-stack">
        <SectionReveal><CategoryMosaic categories={categories} /></SectionReveal>
        {!all.length && (
          <EmptyState
            title="The shelves are getting ready"
            description="Your store is adding its first listings. Come back soon to see what's in season."
          />
        )}
        <ProductRail
          title={demo ? "Popular picks" : "Shelf favorites"}
          description="Familiar favorites for a well-stocked kitchen."
          listings={favorites}
          seeAllHref="/categories"
          seeAllLabel="See all aisles"
        />
      </div>
      <div className="sf-container sf-stack">
        <SectionReveal><CollectionBanners collections={collections} /></SectionReveal>
        <ProductRail
          title={demo ? "Fresh in" : "Fresh ingredients"}
          description="Something good for tonight's pot."
          listings={fresh}
          seeAllHref="/categories/vegetables"
        />
        {pantry && (
          <ProductRail
            title="Pantry, sorted."
            description="Everyday staples worth keeping close."
            listings={pantry.listings}
            seeAllHref="/categories/grains-and-flours"
          />
        )}
        <ProductRail title={demo ? "Back in stock" : "Available today"} description={demo ? "Sample restocked picks from the demo shelves." : "Available on the shelves today."} listings={all.filter(l => l.badge === "in-stock").slice(-8)} seeAllHref="/categories" seeAllLabel="See all aisles" />
      </div>
      <PromoBand
        store={store}
        offer={banners.find((b) => /free delivery/i.test(b.title))?.title}
      />
      <TrustStoryStrip
        profile={extractStoreProfile(store)}
        demo={demo}
        productCount={all.length}
      />
      <ReviewsCarousel demo={demo} />
    </StorefrontShell>
  );
}
