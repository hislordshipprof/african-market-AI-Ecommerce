import Link from "next/link";
import { notFound } from "next/navigation";
import { getStore } from "@/lib/get-store";
import { listingsByCategory } from "@/lib/storefront/service";
import { StorefrontHeader } from "@/components/storefront/storefront-header";
import { ListingCard } from "@/components/storefront/listing-card";

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const store = await getStore();
  const { category, listings } = await listingsByCategory(store.id, slug);

  if (!category) notFound();

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
            <li className="font-semibold text-ink">{category.name}</li>
          </ol>
        </nav>

        <h2
          className="font-display text-ink mb-4"
          style={{ fontSize: "22px", fontWeight: 700, lineHeight: 1.2 }}
        >
          {category.name}
        </h2>

        {listings.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {listings.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </div>
        ) : (
          <div className="rounded-md bg-surface p-8 text-center">
            <p className="font-body font-medium text-ink">
              No listings in {category.name} yet
            </p>
            <p className="mt-1 font-body text-sm text-muted-foreground">
              Try browsing{" "}
              <Link href="/" className="text-primary underline underline-offset-2 hover:no-underline">
                all categories
              </Link>{" "}
              or use the search bar above.
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
