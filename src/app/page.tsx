import Link from "next/link";
import { getStoreWithStatus } from "@/lib/get-store";
import { listCategories, getActiveListings } from "@/lib/storefront/service";
import { StorefrontHeader } from "@/components/storefront/storefront-header";
import { ListingCard } from "@/components/storefront/listing-card";

export default async function StorefrontPage() {
  const { store, suspended } = await getStoreWithStatus();

  if (suspended) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg">
        <div className="text-center">
          <h1
            className="font-display text-ink mb-2"
            style={{ fontSize: "clamp(28px, 4vw, 40px)", fontWeight: 700 }}
          >
            {store.name}
          </h1>
          <p className="text-muted-foreground">
            This store is temporarily offline. Please check back later.
          </p>
        </div>
      </main>
    );
  }

  const [categories, listings] = await Promise.all([
    listCategories(),
    getActiveListings(store.id),
  ]);

  return (
    <main className="min-h-screen bg-bg">
      <StorefrontHeader store={store} />

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {/* Category grid */}
        <section aria-labelledby="categories-heading">
          <h2
            id="categories-heading"
            className="font-display text-ink mb-4"
            style={{ fontSize: "22px", fontWeight: 700, lineHeight: 1.2 }}
          >
            Shop by category
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
            {categories.map((cat) => (
              <Link
                key={cat.id}
                href={`/categories/${cat.slug}`}
                className="flex items-center gap-2.5 rounded-md bg-surface px-4 py-3 transition-colors hover:bg-soft"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-soft font-display text-sm font-bold text-primary">
                  {cat.name.charAt(0)}
                </span>
                <span className="font-label text-xs font-semibold text-ink">
                  {cat.name}
                </span>
              </Link>
            ))}
          </div>
        </section>

        {/* Active listings */}
        {listings.length > 0 && (
          <section aria-labelledby="listings-heading" className="mt-8">
            <h2
              id="listings-heading"
              className="font-display text-ink mb-4"
              style={{ fontSize: "22px", fontWeight: 700, lineHeight: 1.2 }}
            >
              Recently added
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {listings.map((listing) => (
                <ListingCard key={listing.id} listing={listing} />
              ))}
            </div>
          </section>
        )}

        {listings.length === 0 && (
          <section className="mt-8">
            <div className="rounded-md bg-surface p-8 text-center">
              <p className="font-body text-muted-foreground">
                No listings yet. Check back soon.
              </p>
            </div>
          </section>
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
