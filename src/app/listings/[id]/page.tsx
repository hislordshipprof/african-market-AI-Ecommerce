import Link from "next/link";
import { notFound } from "next/navigation";
import { getStore } from "@/lib/get-store";
import { getListingDetail } from "@/lib/storefront/service";
import { formatWeight } from "@/lib/format";
import { StorefrontHeader } from "@/components/storefront/storefront-header";
import { StockBadgeChip } from "@/components/storefront/stock-badge";
import { PriceDisplay } from "@/components/storefront/price-display";

export default async function ListingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const store = await getStore();
  const listing = await getListingDetail(store.id, id);

  if (!listing) notFound();

  return (
    <main className="min-h-screen bg-bg">
      <StorefrontHeader store={store} />

      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
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
            <li className="font-semibold text-ink">{listing.displayName}</li>
          </ol>
        </nav>

        <div className="overflow-hidden rounded-md bg-surface">
          {/* Hero placeholder */}
          <div className="flex aspect-[4/3] w-full items-center justify-center bg-raised sm:aspect-[16/9]">
            <svg
              className="h-16 w-16 text-muted-foreground/20"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1}
              stroke="currentColor"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
            </svg>
          </div>

          <div className="space-y-5 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1
                  className="font-display text-ink"
                  style={{ fontSize: "clamp(22px, 3vw, 28px)", fontWeight: 700, lineHeight: 1.2 }}
                >
                  {listing.displayName}
                </h1>
                {listing.altName && (
                  <p className="mt-1 font-label text-sm text-muted-foreground">
                    {listing.altName}
                  </p>
                )}
              </div>
              <StockBadgeChip badge={listing.badge} />
            </div>

            {(listing.frozen || listing.perishable) && (
              <div className="flex flex-wrap gap-2">
                {listing.frozen && (
                  <span className="inline-flex items-center gap-1 rounded-pill bg-info/10 px-2.5 py-1 font-label text-xs font-semibold text-info">
                    Frozen
                  </span>
                )}
                {listing.perishable && (
                  <span className="inline-flex items-center gap-1 rounded-pill bg-[color:var(--color-deal)]/10 px-2.5 py-1 font-label text-xs font-semibold text-[color:var(--color-deal)]">
                    Perishable — keep refrigerated
                  </span>
                )}
              </div>
            )}

            {/* Variants */}
            {listing.variants.length > 0 ? (
              <section aria-labelledby="variants-heading">
                <h2
                  id="variants-heading"
                  className="font-display text-ink mb-3"
                  style={{ fontSize: "16px", fontWeight: 700 }}
                >
                  Available sizes
                </h2>
                <ul className="divide-y divide-line rounded-md border border-line">
                  {listing.variants.map((v) => (
                    <li
                      key={v.id}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="font-body text-sm font-medium text-ink">
                          {v.label}
                        </p>
                        <p className="font-body text-xs text-muted-foreground">
                          {formatWeight(v.weightG)}
                        </p>
                      </div>
                      <PriceDisplay
                        cents={v.price}
                        className="font-body text-base font-semibold text-ink"
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <p className="font-body text-sm text-muted-foreground">
                Contact the store for pricing and availability.
              </p>
            )}
          </div>
        </div>
      </div>

      <footer className="border-t border-line px-4 py-6 text-center">
        <p className="font-body text-sm text-muted-foreground">
          Powered by the Platform
        </p>
      </footer>
    </main>
  );
}
