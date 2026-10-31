import { getStoreWithStatus } from "@/lib/get-store";
import {
  listCategories,
  getActiveBanners,
  getActiveCollections,
  getListingsByCategory,
  extractStoreProfile,
} from "@/lib/storefront/service";
import { StorefrontHeader } from "@/components/storefront/storefront-header";
import { HeroCarousel } from "@/components/storefront/hero-carousel";
import { CategoryMosaic } from "@/components/storefront/category-mosaic";
import { ProductRail } from "@/components/storefront/product-rail";
import { CollectionBanners } from "@/components/storefront/collection-banner";
import { PromoBand } from "@/components/storefront/promo-band";
import { TrustStoryStrip } from "@/components/storefront/trust-story-strip";
import { StorefrontFooter } from "@/components/storefront/storefront-footer";

export default async function StorefrontPage() {
  const { store, suspended } = await getStoreWithStatus();

  if (suspended) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg">
        <div className="text-center">
          <h1
            className="font-display text-ink mb-2"
            style={{ fontSize: "clamp(28px, 4vw, 40px)", fontWeight: 700 }}
          >
            {store.name}
          </h1>
          <p className="text-muted-foreground">
            This store is temporarily offline. Please check back later.
          </p>
        </div>
      </main>
    );
  }

  const [categories, banners, collections, listingsByCategory] =
    await Promise.all([
      listCategories(),
      getActiveBanners(store.id),
      getActiveCollections(store.id),
      getListingsByCategory(store.id),
    ]);

  const profile = extractStoreProfile(store);

  const CURATED_LABELS: Record<string, string> = {
    "Tubers & Roots": "Fresh Tubers & Roots",
    "Spices & Seasonings": "Spice Cabinet",
    "Fish & Meat": "Fresh Catch & Meats",
    "Vegetables": "Market Vegetables",
    "Snacks": "Snack Run",
    "Pantry Staples": "Stock Up — Pantry Staples",
  };

  const MAX_HOME_RAILS = 4;
  const visibleRails = listingsByCategory.slice(0, MAX_HOME_RAILS);
  const hasMoreRails = listingsByCategory.length > MAX_HOME_RAILS;

  return (
    <main className="min-h-screen bg-bg">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-on-primary focus:shadow-lg"
      >
        Skip to content
      </a>
      <StorefrontHeader store={store} />

      <HeroCarousel banners={banners} />

      <div id="main-content" className="mx-auto max-w-6xl space-y-10 px-4 py-8 sm:px-6">
        <CategoryMosaic categories={categories} />

        <TrustStoryStrip profile={profile} />

        {visibleRails.map((rail) => (
          <ProductRail
            key={rail.categorySlug}
            title={CURATED_LABELS[rail.categoryName] ?? rail.categoryName}
            categorySlug={rail.categorySlug}
            listings={rail.listings}
            seeAllHref={`/categories/${rail.categorySlug}`}
          />
        ))}

        {hasMoreRails && (
          <div className="flex justify-center">
            <a
              href="/categories"
              className="inline-flex h-12 items-center rounded-pill bg-soft px-8 font-label text-sm font-semibold text-primary transition-colors hover:bg-raised"
            >
              Browse all categories &rarr;
            </a>
          </div>
        )}

        <CollectionBanners collections={collections} />
      </div>

      <PromoBand store={store} />

      <StorefrontFooter store={store} />
    </main>
  );
}
