import Link from "next/link";
import type { StorefrontCollection } from "@/lib/storefront/service";

export function CollectionBanners({
  collections,
}: {
  collections: StorefrontCollection[];
}) {
  if (collections.length === 0) return null;

  return (
    <section
      data-testid="collection-banners"
      aria-labelledby="collections-heading"
    >
      <h2
        id="collections-heading"
        className="mb-4 font-display text-[22px] font-bold leading-[1.2] text-ink"
      >
        Curated collections
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {collections.map((col) => (
          <Link
            key={col.id}
            href={`/collections/${col.slug}`}
            className="group relative overflow-hidden rounded-lg focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            style={{ aspectRatio: "21/9" }}
          >
            <div
              className="absolute inset-0 bg-primary-deep bg-cover bg-center transition-all duration-300 group-hover:brightness-110"
              style={{
                backgroundImage: col.imageUrl
                  ? `url(${col.imageUrl})`
                  : undefined,
                transitionTimingFunction: "var(--ease-std)",
              }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
            <div className="relative flex h-full flex-col justify-end p-4 sm:p-5">
              <h3 className="font-display text-lg font-bold text-white sm:text-xl">
                {col.title}
              </h3>
              {col.subtitle && (
                <p className="mt-0.5 font-body text-sm text-white/80">
                  {col.subtitle}
                </p>
              )}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
