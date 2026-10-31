import Link from "next/link";

interface MosaicCategory {
  id: string;
  name: string;
  slug: string;
  localName: string | null;
  imageUrl: string | null;
}

function bentoSpan(i: number, total: number): string {
  if (i === 0) return "col-span-2 row-span-2";
  if (i === total - 1 && total % 2 === 0) return "col-span-2";
  return "";
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
        className="mb-4 font-display text-[22px] font-bold leading-[1.2] text-ink"
      >
        Shop by category
      </h2>
      <div className="grid auto-rows-[140px] grid-cols-2 gap-3 sm:auto-rows-[160px] sm:grid-cols-3 lg:auto-rows-[170px] lg:grid-cols-4">
        {categories.map((cat, i) => (
          <Link
            key={cat.id}
            href={`/categories/${cat.slug}`}
            className={`group relative overflow-hidden rounded-md focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${bentoSpan(i, categories.length)}`}
          >
            <div
              className="absolute inset-0 bg-primary-deep bg-cover bg-center transition-transform duration-200 group-hover:scale-[1.03]"
              style={{
                backgroundImage: cat.imageUrl
                  ? `url(${cat.imageUrl})`
                  : undefined,
                transitionTimingFunction: "var(--ease-std)",
              }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent group-hover:from-black/80" />
            <div className="relative flex h-full flex-col justify-end p-3">
              <span className="font-display text-sm font-bold leading-tight text-white sm:text-base">
                {cat.name}
              </span>
              {cat.localName && (
                <span className="font-label text-[13px] tracking-wider text-white/70">
                  {cat.localName}
                </span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
