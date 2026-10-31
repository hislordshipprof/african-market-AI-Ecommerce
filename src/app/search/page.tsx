import Link from "next/link";
import { getStore } from "@/lib/get-store";
import { searchListings } from "@/lib/storefront/service";
import { StorefrontHeader } from "@/components/storefront/storefront-header";
import { StockBadgeChip } from "@/components/storefront/stock-badge";
import { PriceDisplay } from "@/components/storefront/price-display";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const raw = (await searchParams).q;
  const q = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] ?? "" : "";
  const store = await getStore();
  const results = q.trim() ? await searchListings(store.id, q) : [];

  return (
    <main className="min-h-screen bg-bg">
      <StorefrontHeader store={store} />

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <nav aria-label="Breadcrumb" className="mb-4">
          <ol className="flex items-center gap-1.5 font-body text-sm text-muted-foreground">
            <li>
              <Link href="/" className="hover:text-primary">
                Home
              </Link>
            </li>
            <li aria-hidden="true">
              <svg className="h-3.5 w-3.5 text-muted-foreground/60" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
            </li>
            <li className="font-semibold text-ink">Search</li>
          </ol>
        </nav>

        <h2
          className="font-display text-ink mb-4"
          style={{ fontSize: "22px", fontWeight: 700, lineHeight: 1.2 }}
        >
          {q.trim()
            ? `Results for "${q.trim()}"`
            : "Search"}
        </h2>

        {results.length > 0 ? (
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {results.map((result) => (
              <li key={result.id}>
                <Link
                  href={`/listings/${result.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-soft"
                >
                  <div className="min-w-0">
                    <p className="truncate font-body text-sm font-medium text-ink">
                      {result.name}
                    </p>
                    {result.altName && (
                      <p className="truncate font-label text-xs text-muted-foreground">
                        {result.altName}
                      </p>
                    )}
                    <PriceDisplay
                      cents={result.price}
                      prefix="From "
                      className="font-body text-xs text-muted-foreground"
                    />
                  </div>
                  <StockBadgeChip badge={result.badge} />
                </Link>
              </li>
            ))}
          </ul>
        ) : q.trim() ? (
          <div className="rounded-md bg-surface p-8 text-center">
            <svg className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <p className="font-body font-medium text-ink">
              No results for &ldquo;{q.trim()}&rdquo;
            </p>
            <p className="mt-1 font-body text-sm text-muted-foreground">
              Check the spelling or try a broader term.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {["ugu", "garri", "egusi", "plantain", "yam"].map((term) => (
                <Link
                  key={term}
                  href={`/search?q=${encodeURIComponent(term)}`}
                  className="rounded-pill border border-line bg-raised px-3 py-1 font-body text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                >
                  {term}
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-md bg-surface p-8 text-center">
            <svg className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <p className="font-body font-medium text-ink">
              Search this store
            </p>
            <p className="mt-1 font-body text-sm text-muted-foreground">
              Find products by their local or English name.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {["ugu", "garri", "egusi", "plantain", "yam"].map((term) => (
                <Link
                  key={term}
                  href={`/search?q=${encodeURIComponent(term)}`}
                  className="rounded-pill border border-line bg-raised px-3 py-1 font-body text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                >
                  Try &ldquo;{term}&rdquo;
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      <footer className="border-t border-line px-4 py-6 text-center">
        <p className="font-body text-sm text-muted-foreground">
          Powered by the Platform
        </p>
      </footer>
    </main>
  );
}
