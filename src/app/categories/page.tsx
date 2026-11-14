import { getStore } from "@/lib/get-store";
import { listCategories } from "@/lib/storefront/service";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { CategoryMosaic } from "@/components/storefront/category-mosaic";
import { EmptyState } from "@/components/storefront/primitives";
export default async function CategoriesPage() {
  const [store, categories] = await Promise.all([getStore(), listCategories()]);
  return (
    <StorefrontShell store={store}>
      <div className="sf-container sf-stack">
        <div>
          <h2 className="sf-page-title">Shop by category</h2>
          <p className="sf-page-intro">
            Find your everyday staples and the flavors of home.
          </p>
        </div>
        {categories.length ? (
          <CategoryMosaic categories={categories} all />
        ) : (
          <EmptyState
            title="The aisles are being stocked"
            description="Check back soon to explore this market."
          />
        )}
      </div>
    </StorefrontShell>
  );
}
