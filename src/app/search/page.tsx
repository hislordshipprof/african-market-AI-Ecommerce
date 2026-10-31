import Link from "next/link";
import { getStore } from "@/lib/get-store";
import { searchListings } from "@/lib/storefront/service";
import { formatPrice } from "@/lib/format";
import { StorefrontHeader } from "@/components/storefront/storefront-header";
import { StockBadgeChip } from "@/components/storefront/stock-badge";

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
            <li aria-hidden="true">/</li>
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
                    <p className="font-body text-xs text-muted-foreground">
                      From {formatPrice(result.price)}
                    </p>
                  </div>
                  <StockBadgeChip badge={result.badge} />
                </Link>
              </li>
            ))}
          </ul>
        ) : q.trim() ? (
          <div className="rounded-md bg-surface p-8 text-center">
            <p className="font-body text-muted-foreground">
              No results for &ldquo;{q.trim()}&rdquo;. Try a different spelling.
            </p>
          </div>
        ) : (
          <div className="rounded-md bg-surface p-8 text-center">
            <p className="font-body text-muted-foreground">
              Type a search term above to find listings.
            </p>
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
