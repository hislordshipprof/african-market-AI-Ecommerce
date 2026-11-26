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
import { headers } from "next/headers";
import { Suspense } from "react";
import { PlanComparison } from "@/components/billing/plan-comparison";
import { listDirectoryStores } from "@/lib/directory/stores";
import { storefrontUrl } from "@/lib/directory/links";
import { DirectoryHome } from "@/components/directory/directory-home";
import { statePages } from "@/lib/directory/places";
import { feeNote } from "@/lib/directory/fee-note";
import { pilotOffer } from "@/lib/billing/service";
import { readServiceFeeSettings } from "@/lib/order/service-fee-settings";

// The pilot offer and the fee note read the database, so they stream in on their own and the rest of the
// home renders in one pass: a /#stores-by-state link then lands on the list (#810, #863).
async function DirectoryPlans() {
  return <PlanComparison offer={await pilotOffer()} recommend />;
}

async function DirectoryFeeNote() {
  return feeNote(await readServiceFeeSettings());
}

export default async function StorefrontPage() {
  const headerList = await headers();
  // The proxy marks the root domain and www only when no store matched the request.
  if (headerList.get("x-platform-root") === "1") {
    const host = headerList.get("host") ?? "";
    const stores = (await listDirectoryStores()).flatMap((store) => {
      const href = storefrontUrl(store.slug, host);
      return href ? [{ ...store, href }] : [];
    });
    const states = statePages(stores).map(({ code, name, slug, stores, cities }) => ({
      code,
      name,
      href: `/stores/${slug}`,
      count: stores.length,
      cities: cities.map((city) => ({ name: city.name, href: `/stores/${slug}/${city.slug}`, count: city.stores.length })),
    }));
    return (
      <DirectoryHome
        stores={stores}
        states={states}
        plans={<Suspense fallback={<PlanComparison recommend />}><DirectoryPlans /></Suspense>}
        feeNote={<Suspense fallback={null}><DirectoryFeeNote /></Suspense>}
      />
    );
  }
  const { store, suspended } = await getStoreWithStatus();
  const checkout = checkCheckoutReady(store);
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
  // A store in setup is not open yet (#555): no shelves, no cart, no checkout until it goes live.
  if (store.status === "setup")
    return (
      <main className="sf-storefront sf-section sf-container">
        <h1 className="sf-page-title">{store.name}</h1>
        <EmptyState
          title="Opening soon"
          description="We're getting the shelves ready. Online ordering opens soon."
        >
          {/* No "Explore the aisles" link: nothing can be bought until the store goes live. */}
          <></>
        </EmptyState>
      </main>
    );
  const [categories, banners, collections, rails] = await Promise.all([
    listCategories(store.id),
    getActiveBanners(store.id),
    getActiveCollections(store.id),
    getListingsByCategory(store.id),
  ]);
  const all = rails.flatMap((r) => r.listings);
  const favorites = all
    .filter((l) => l.imageUrl && l.badge !== "ask-store" && !l.frozen)
    .slice(0, 10);
  const fresh = all.filter((l) => l.perishable && !l.frozen).slice(0, 10);
  const pantry = rails.find((r) => r.categorySlug === "fufu-flours-and-swallow");
  const demo = demoFlowsEnabled(process.env) && ["mama-ngozi", "tante-marie"].includes(store.slug);
  const subjects = ["Plantain", "Scotch Bonnet Pepper", "Yam"].flatMap(name => all.filter(p => p.displayName === name)).slice(0, 3);
  return (
    <StorefrontShell store={store}>
      {!checkout.enabled && (
        <div className="sf-container" style={{ paddingBlock: "var(--sf-space-sm)" }}>
          <div className="rounded-lg border border-line bg-raised px-4 py-3 text-sm text-ink">
            {checkout.message}
          </div>
        </div>
      )}
      <HeroCarousel banners={banners} products={subjects.length ? subjects : favorites.slice(0, 3)} pickupMinutes={store.prepTimeMinutes} pickupEnabled={store.pickupEnabled} hours={store.hours} timezone={store.timezone} />
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
          seeAllHref="/categories/fresh-produce"
        />
        {pantry && (
          <ProductRail
            title="Pantry, sorted."
            description="Everyday staples worth keeping close."
            listings={pantry.listings}
            seeAllHref="/categories/fufu-flours-and-swallow"
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
