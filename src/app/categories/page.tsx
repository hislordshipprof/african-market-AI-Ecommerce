import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getStore } from "@/lib/get-store";
import { listCategories } from "@/lib/storefront/service";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { CategoryMosaic } from "@/components/storefront/category-mosaic";
import { EmptyState } from "@/components/storefront/primitives";
export default async function CategoriesPage() {
  const store = await getStore();
  const categories = await listCategories(store.id);
  return (
    <StorefrontShell store={store} pageTitled>
      <div className="sf-container sf-stack">
        <div>
          <h1 className="sf-page-title">All aisles</h1>
          <p className="sf-page-intro">
            Your everyday staples and the flavors of home.
          </p>
        </div>
        {categories.length ? (
          <CategoryMosaic categories={categories} all />
        ) : (
          <EmptyState
            title="The aisles are being stocked"
            description="Check back soon to explore this market."
          >
            <Link href="/" className="sf-button">
              Back to the store <ArrowRight size={18} aria-hidden />
            </Link>
          </EmptyState>
        )}
      </div>
    </StorefrontShell>
  );
}
