import { getStoreWithStatus } from "@/lib/get-store";
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

export default async function StorefrontPage() {
  const { store, suspended } = await getStoreWithStatus();
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
  return (
    <StorefrontShell store={store}>
      <HeroCarousel banners={banners} />
      <div className="sf-container sf-stack">
        <CategoryMosaic categories={categories} />
        {!all.length && (
          <EmptyState
            title="The shelves are getting ready"
            description="Your store is adding its first listings. Come back soon to see what's in season."
          />
        )}
        <ProductRail
          title="Popular picks"
          description="Familiar favorites for a well-stocked kitchen."
          listings={favorites}
          seeAllHref="/categories"
        />
        <CollectionBanners collections={collections.slice(0, 2)} />
        <ProductRail
          title="Fresh in"
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
      </div>
      <PromoBand
        store={store}
        offer={banners.find((b) => /free delivery/i.test(b.title))?.title}
      />
      <TrustStoryStrip
        profile={extractStoreProfile(store)}
        demo={["mama-ngozi", "tante-marie"].includes(store.slug)}
      />
    </StorefrontShell>
  );
}
