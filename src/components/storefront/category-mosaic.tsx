import Link from "next/link";

interface MosaicCategory {
  id: string;
  name: string;
  slug: string;
  localName: string | null;
  imageUrl: string | null;
}

export function CategoryMosaic({
  categories,
}: {
  categories: MosaicCategory[];
}) {
  return (
    <section data-testid="category-mosaic" aria-labelledby="mosaic-heading">
      <h2
        id="mosaic-heading"
        className="mb-4 font-display text-ink"
        style={{ fontSize: "22px", fontWeight: 700, lineHeight: 1.2 }}
      >
        Shop by category
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {categories.map((cat) => (
          <Link
            key={cat.id}
            href={`/categories/${cat.slug}`}
            className="group relative overflow-hidden rounded-md"
            style={{ aspectRatio: "4/3" }}
          >
            <div
              className="absolute inset-0 bg-primary-deep bg-cover bg-center transition-transform duration-200"
              style={{
                backgroundImage: cat.imageUrl
                  ? `url(${cat.imageUrl})`
                  : undefined,
                transitionTimingFunction: "var(--ease-std)",
              }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent group-hover:from-black/80" />
            <div className="absolute inset-0 transition-transform duration-200 group-hover:scale-[1.02]" />
            <div className="relative flex h-full flex-col justify-end p-3">
              {cat.localName && (
                <span className="font-label text-[11px] uppercase tracking-wider text-white/80">
                  {cat.localName}
                </span>
              )}
              <span className="font-display text-sm font-bold leading-tight text-white sm:text-base">
                {cat.name}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
