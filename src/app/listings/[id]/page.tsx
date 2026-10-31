import Link from "next/link";
import { notFound } from "next/navigation";
import { getStore } from "@/lib/get-store";
import { getListingDetail } from "@/lib/storefront/service";
import { formatPrice, formatWeight } from "@/lib/format";
import { StorefrontHeader } from "@/components/storefront/storefront-header";
import { StockBadgeChip } from "@/components/storefront/stock-badge";

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
            <li aria-hidden="true">/</li>
            <li className="font-semibold text-ink">{listing.displayName}</li>
          </ol>
        </nav>

        <div className="overflow-hidden rounded-md bg-surface">
          {/* Hero placeholder */}
          <div className="aspect-[4/3] w-full bg-raised sm:aspect-[16/9]" />

          <div className="space-y-5 p-5">
            <div className="flex items-start justify-between gap-3">
              <h1
                className="font-display text-ink"
                style={{ fontSize: "clamp(22px, 3vw, 28px)", fontWeight: 700, lineHeight: 1.2 }}
              >
                {listing.displayName}
              </h1>
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
                      <span className="font-body text-base font-semibold text-ink">
                        {formatPrice(v.price)}
                      </span>
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
