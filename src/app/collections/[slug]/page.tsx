import { ProductListMotion } from "@/components/storefront/product-list-motion";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStore } from "@/lib/get-store";
import { getCollectionListings } from "@/lib/storefront/service";
import { editorial, photoOrFallback } from "@/lib/storefront/editorial";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { ListingCard } from "@/components/storefront/listing-card";
import { EmptyState } from "@/components/storefront/primitives";
export default async function CollectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [{ slug }, store] = await Promise.all([params, getStore()]);
  const { collection, listings } = await getCollectionListings(store.id, slug);
  if (!collection) notFound();
  return (
    <StorefrontShell store={store}>
      <div className="sf-container">
        <nav className="sf-breadcrumb" aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span aria-hidden>/</span>
          <span>{collection.title}</span>
        </nav>
        <section className="sf-collection-hero">
          <Image
            src={photoOrFallback(collection.imageUrl, editorial.jollof)}
            alt=""
            fill
            sizes="(max-width:767px) 92vw, 1200px"
            preload
          />
          <div className="sf-photo-scrim" />
          <div>
            <h2 className="sf-page-title">{collection.title}</h2>
            {collection.subtitle && <p>{collection.subtitle}</p>}
          </div>
        </section>
        <section className="sf-section" aria-label="Collection products">
          {listings.length ? (
            <ProductListMotion className="sf-grid">
              {listings.map((l) => (
                <ListingCard key={l.id} listing={l} />
              ))}
            </ProductListMotion>
          ) : (
            <EmptyState
              title="More good things on the way"
              description="This collection is being stocked. Explore the market in the meantime."
            />
          )}
        </section>
      </div>
    </StorefrontShell>
  );
}
