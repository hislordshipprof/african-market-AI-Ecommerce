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
  const categoryRails = Array.from(listingsByCategory.entries());

  return (
    <main className="min-h-screen bg-bg">
      <StorefrontHeader store={store} />

      <HeroCarousel banners={banners} />

      <div className="mx-auto max-w-6xl space-y-10 px-4 py-8 sm:px-6">
        <CategoryMosaic categories={categories} />

        {categoryRails.map(([catName, listings]) => (
          <ProductRail key={catName} title={catName} listings={listings} />
        ))}

        <CollectionBanners collections={collections} />
      </div>

      <PromoBand store={store} />

      <TrustStoryStrip profile={profile} />

      <StorefrontFooter store={store} />
    </main>
  );
}
