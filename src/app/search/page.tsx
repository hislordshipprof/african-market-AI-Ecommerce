import { ProductListMotion } from "@/components/storefront/product-list-motion";
import Link from "next/link";
import { getStore } from "@/lib/get-store";
import { searchListings } from "@/lib/storefront/service";
import { SEARCH_QUERY_TOO_LONG, normalizedSearchQuery } from "@/lib/storefront/search-query";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { ListingCard } from "@/components/storefront/listing-card";
import { EmptyState } from "@/components/storefront/primitives";
import { RecentSearches } from "@/components/storefront/recent-searches";
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; frozen?: string | string[]; sort?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = params.q;
  const { query: q, tooLong } = normalizedSearchQuery(
    typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] || "" : "",
  );
  const store = await getStore();
  const results = q && !tooLong ? await searchListings(store.id, q) : [];
  const frozen = params.frozen === "1";
  const sort = params.sort === "price-low" || params.sort === "price-high" ? params.sort : "";
  const href = (updates: { frozen?: string; sort?: string }) => {
    const p = new URLSearchParams({ q });
    const next = { frozen: frozen ? "1" : "", sort, ...updates };
    if (next.frozen) p.set("frozen", next.frozen);
    if (next.sort) p.set("sort", next.sort);
    return `/search?${p}`;
  };
  const visible = results.filter((r) => !frozen || r.frozen);
  if (sort === "price-low") visible.sort((a, b) => a.price - b.price);
  if (sort === "price-high") visible.sort((a, b) => b.price - a.price);
  const clearHref = href({ frozen: "", sort: "" });
  return (
    <StorefrontShell store={store}>
      <div className="sf-container sf-search-page">
        <nav className="sf-breadcrumb" aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span>/</span>
          <span>Search</span>
        </nav>
        <h2 className="sf-page-title">
          {tooLong ? SEARCH_QUERY_TOO_LONG : q ? `Results for “${q}”` : "What's cooking?"}
        </h2>
        {!q && (
          <p className="sf-page-intro">
            Search the names you know. Ugu, egusi, garri — you’re in the right
            place.
          </p>
        )}
        {tooLong ? (
          <p className="sf-page-intro" role="status">
            {SEARCH_QUERY_TOO_LONG}. Use 200 characters or fewer.
          </p>
        ) : q ? (
          <div className="sf-section">
            {results.length > 0 && (
              <div className="sf-filters">
                <Link
                  className="sf-chip"
                  data-testid="filter-frozen"
                  aria-current={frozen ? "page" : undefined}
                  href={href({ frozen: frozen ? "" : "1" })}
                >
                  Frozen
                </Link>
                <form action="/search">
                  <input type="hidden" name="q" value={q} />
                  {frozen && <input type="hidden" name="frozen" value="1" />}
                  <label className="sr-only" htmlFor="search-sort">
                    Sort products
                  </label>
                  <select id="search-sort" name="sort" defaultValue={sort}>
                    <option value="">Best match</option>
                    <option value="price-low">Price: low to high</option>
                    <option value="price-high">Price: high to low</option>
                  </select>
                  <button className="sf-chip" type="submit">
                    Sort
                  </button>
                </form>
              </div>
            )}
            <p
              className={results.length ? "sf-result-count" : "sr-only"}
              role="status"
            >
              {visible.length} {visible.length === 1 ? "product" : "products"}{" "}
              in this store
              {(frozen || sort) && results.length > 0 && (
                <>
                  {" "}
                  /{" "}
                  <Link data-testid="clear-filters" href={clearHref}>
                    Clear filters
                  </Link>
                </>
              )}
            </p>
            {visible.length ? (
              <ProductListMotion as="ul" className="sf-grid sf-search-results">
                {visible.map((r) => (
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
                      maxPerOrder: r.maxPerOrder,
                      imageUrl: r.imageUrl,
                      categorySlug: r.categorySlug,
                      variantId: r.variantId,
                      packLabel: r.packLabel,
                      weightG: r.weightG,
                    }}
                  />
                ))}
              </ProductListMotion>
            ) : results.length ? (
              <EmptyState
                title="No products match these filters"
                description="Clear the filters to see every result for your search."
              >
                <Link className="sf-button" data-testid="clear-filters" href={clearHref}>
                  Clear filters
                </Link>
              </EmptyState>
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
