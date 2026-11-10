import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { categoryPhotos } from "@/lib/storefront/catalog";
import { storefrontPhoto } from "@/lib/storefront/images";
import { ProductImage } from "./product-image";
import { RailScroller } from "./rail-scroller";
import { SectionHeader } from "./primitives";
interface MosaicCategory {
  id: string;
  name: string;
  slug: string;
  localName: string | null;
  imageUrl: string | null;
}
export function CategoryMosaic({
  categories,
  all = false,
}: {
  categories: MosaicCategory[];
  all?: boolean;
}) {
  if (!categories.length) return null;
  const visible = all
    ? categories
    : categories.filter((c) =>
        [
          "tubers-and-roots",
          "grains-and-flours",
          "spices-and-seasonings",
          "vegetables",
          "fish-and-meat",
          "snacks",
        ].includes(c.slug),
      );
  return (
    <section data-testid="category-mosaic" aria-label="Store aisles">
      {all && <SectionHeader
        id="mosaic-heading"
        title="Aisles full of home"
        description="The staples you know. A few new favorites."
        href={all ? undefined : "/categories"}
      />}
      <RailScroller className={all ? "sf-category-rail sf-all-categories" : "sf-category-rail"} label="Categories" title={all ? "Find your favorites" : "Aisles full of home"} description="The staples you know. A few new favorites." href={all ? undefined : "/categories"} hrefLabel="See all aisles">
        {visible.map((cat) => (
          <Link
            key={cat.id}
            href={`/categories/${cat.slug}`}
            className="sf-category-tile"
            aria-label={cat.localName ? `${cat.name}, ${cat.localName}` : cat.name}
          >
            <ProductImage src={storefrontPhoto(cat.imageUrl) || (categoryPhotos[cat.slug]?.startsWith("/images/products/") ? categoryPhotos[cat.slug] : undefined)} name={cat.name} category={cat.slug} sizes="(max-width:767px) 44vw, 320px" />
            <div>
              <span>
                {cat.localName && <small>{cat.localName}</small>}
                <strong>{cat.name}</strong>
              </span>
              <ArrowUpRight size={20} aria-hidden />
            </div>
          </Link>
        ))}
      </RailScroller>
    </section>
  );
}
