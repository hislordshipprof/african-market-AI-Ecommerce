import { ProductListMotion } from "@/components/storefront/product-list-motion";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStore } from "@/lib/get-store";
import { listingsByCategory } from "@/lib/storefront/service";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { ListingCard } from "@/components/storefront/listing-card";
import { EmptyState } from "@/components/storefront/primitives";
import { AislePicker, AisleTree } from "@/components/storefront/aisle-menu";
import { FilterSheet } from "@/components/storefront/filter-sheet";
type Query = Record<string, string | string[] | undefined>;
export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Query>;
}) {
  const [{ slug }, query, store] = await Promise.all([
    params,
    searchParams,
    getStore(),
  ]);
  const { category, listings } = await listingsByCategory(store.id, slug);
  if (!category) notFound();
  const value = (key: string) =>
    typeof query[key] === "string" ? (query[key] as string) : "";
  const stock = value("stock") === "1",
    frozen = value("frozen") === "1",
    pack = value("pack"),
    sort = value("sort");
  const packs = [
    ...new Set(
      listings
        .flatMap((l) => (l.packLabels?.length ? l.packLabels : [l.packLabel]))
        .filter((p): p is string => !!p),
    ),
  ].sort();
  const href = (updates: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const key of ["stock", "frozen", "pack", "sort", "sizes"]) {
      const v = key in updates ? updates[key] : value(key);
      if (v) p.set(key, v);
    }
    return `/categories/${slug}${p.size ? `?${p}` : ""}`;
  };
  const visible = listings
    .filter(
      (l) =>
        (!stock || l.badge === "in-stock") &&
        (!frozen || l.frozen) &&
        (!pack ||
          (l.packLabels?.length ? l.packLabels : [l.packLabel]).includes(pack)),
    )
    .map((listing) => {
      const selected = listing.packOptions?.find(
        (option) => option.label === pack,
      );
      return selected
        ? {
            ...listing,
            variantId: selected.id,
            packLabel: selected.label,
            weightG: selected.weightG,
            startingPrice: selected.price,
          }
        : listing;
    });
  if (sort === "price-low")
    visible.sort((a, b) => a.startingPrice - b.startingPrice);
  if (sort === "price-high")
    visible.sort((a, b) => b.startingPrice - a.startingPrice);
  if (sort === "name")
    visible.sort((a, b) => a.displayName.localeCompare(b.displayName));
  // The refine filters: under the aisle rail on desktop, in the Filter sheet on phones (#862).
  const refine = (
    <>
      <div className="sf-refine-chips">
        <Link
          className="sf-chip"
          data-testid="filter-in-stock"
          aria-current={stock ? "page" : undefined}
          href={href({ stock: stock ? "" : "1" })}
        >
          In stock
        </Link>
        <Link
          className="sf-chip"
          data-testid="filter-frozen"
          aria-current={frozen ? "page" : undefined}
          href={href({ frozen: frozen ? "" : "1" })}
        >
          Frozen
        </Link>
        <Link
          className="sf-chip"
          data-testid="filter-pack-size"
          aria-expanded={value("sizes") === "1"}
          aria-current={pack ? "page" : undefined}
          href={href({ sizes: value("sizes") === "1" ? "" : "1" })}
        >
          Pack size
        </Link>
      </div>
      {value("sizes") === "1" && (
        <div className="sf-refine-chips" aria-label="Pack sizes">
          {packs.map((p) => (
            <Link
              className="sf-chip"
              data-testid="filter-pack-option"
              aria-current={pack === p ? "page" : undefined}
              key={p}
              href={href({ pack: pack === p ? "" : p })}
            >
              {p}
            </Link>
          ))}
          {!packs.length && <p>No pack sizes available.</p>}
        </div>
      )}
    </>
  );
  return (
    <StorefrontShell store={store} pageTitled>
      <div className="sf-container">
        <nav className="sf-breadcrumb" aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span aria-hidden>/</span>
          <Link href="/categories">Aisles</Link>
          <span aria-hidden>/</span>
          {category.aisle && (
            <>
              <Link href={`/categories/${category.aisle.slug}`}>{category.aisle.name}</Link>
              <span aria-hidden>/</span>
            </>
          )}
          <span>{category.name}</span>
        </nav>
        <div className="sf-browse">
          <aside className="sf-aisle-rail" aria-label="Aisles">
            <h2 className="sf-aisle-rail-title">Aisles</h2>
            <AisleTree key={category.aisle?.slug ?? slug} idPrefix="rail" />
            <section className="sf-refine" aria-label="Refine">
              <h2 className="sf-aisle-rail-title">Refine</h2>
              {refine}
            </section>
          </aside>
          <section aria-label={category.name}>
            <h1 className="sf-page-title">{category.name}</h1>
            <p className="sf-page-intro">
              Good ingredients for the meals you love.
            </p>
            <div className="sf-aisle-tools">
              <AislePicker />
              <FilterSheet active={stock || frozen || !!pack}>{refine}</FilterSheet>
            </div>
            <div className="sf-filters">
              <p className="sf-result-count">
              {visible.length} {visible.length === 1 ? "product" : "products"}
              {(stock || frozen || pack) && (
                <>
                  {" "}
                  /{" "}
                  <Link
                    data-testid="clear-filters"
                    href={`/categories/${slug}`}
                  >
                    Clear filters
                  </Link>
                </>
              )}
            </p>
              <form action={`/categories/${slug}`}>
                <input type="hidden" name="stock" value={stock ? "1" : ""} />
                <input type="hidden" name="frozen" value={frozen ? "1" : ""} />
                <input type="hidden" name="pack" value={pack} />
                <label className="sr-only" htmlFor="category-sort">
                  Sort products
                </label>
                <select id="category-sort" name="sort" defaultValue={sort}>
                  <option value="">Recommended</option>
                  <option value="price-low">Price: low to high</option>
                  <option value="price-high">Price: high to low</option>
                  <option value="name">Name: A to Z</option>
                </select>
                <button className="sf-chip" type="submit">
                  Sort
                </button>
              </form>
            </div>
            {visible.length ? (
              <ProductListMotion className="sf-grid">
                {visible.map((l) => (
                  <ListingCard key={l.id} listing={l} />
                ))}
              </ProductListMotion>
            ) : (
              <EmptyState
                title="No products found"
                description="Try clearing your filters or exploring another aisle."
              >
                <Link
                  className="sf-button"
                  data-testid="clear-filters"
                  href={`/categories/${slug}`}
                >
                  Clear filters
                </Link>
                <Link className="sf-text-link" href="/categories">
                  Browse all categories
                </Link>
              </EmptyState>
            )}
          </section>
        </div>
      </div>
    </StorefrontShell>
  );
}
