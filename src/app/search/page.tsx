import { ProductListMotion } from "@/components/storefront/product-list-motion";
import Link from "next/link";
import { getStore } from "@/lib/get-store";
import { searchListings } from "@/lib/storefront/service";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { ListingCard } from "@/components/storefront/listing-card";
import { EmptyState } from "@/components/storefront/primitives";
import { RecentSearches } from "@/components/storefront/recent-searches";
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const raw = (await searchParams).q;
  const q = (
    typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] || "" : ""
  ).trim();
  const store = await getStore();
  const results = q ? await searchListings(store.id, q) : [];
  return (
    <StorefrontShell store={store}>
      <div className="sf-container sf-search-page">
        <nav className="sf-breadcrumb" aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span>/</span>
          <span>Search</span>
        </nav>
        <h2 className="sf-page-title">
          {q ? `Results for "${q}"` : "What's cooking?"}
        </h2>
        <p className="sf-page-intro">
          Search the names you know. Ugu, egusi, garri — you’re in the right
          place.
        </p>
        {q ? (
          <div className="sf-section">
            <p className="sf-result-count" role="status">
              {results.length} {results.length === 1 ? "listing" : "listings"}{" "}
              in this store
            </p>
            {results.length ? (
              <ProductListMotion as="ul" className="sf-grid sf-search-results">
                {results.map((r) => (
                  <ListingCard
                    key={r.id}
                    listing={{
                      id: r.id,
                      displayName: r.name,
                      altName: r.altName,
                      startingPrice: r.price,
                      badge: r.badge,
                      frozen: r.frozen,
                      perishable: r.perishable,
                      imageUrl: r.imageUrl,
                      variantId: r.variantId,
                      packLabel: r.packLabel,
                      weightG: r.weightG,
                    }}
                  />
                ))}
              </ProductListMotion>
            ) : (
              <EmptyState
                title={`No results for "${q}"`}
                description="Try a local or English name, check the spelling, or explore a whole aisle."
              >
                <div className="sf-search-suggestions">
                  {["egusi", "ugu", "garri", "plantain"].map((term) => (
                    <Link
                      className="sf-chip"
                      key={term}
                      href={`/search?q=${term}`}
                    >
                      {term}
                    </Link>
                  ))}
                </div>
                <Link className="sf-button" href="/categories">
                  Browse all aisles
                </Link>
              </EmptyState>
            )}
          </div>
        ) : (
          <RecentSearches storeId={store.id} />
        )}
      </div>
    </StorefrontShell>
  );
}
