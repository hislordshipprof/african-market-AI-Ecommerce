import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { categoryPhotos } from "@/lib/storefront/catalog";
import { storefrontPhoto } from "@/lib/storefront/images";
import { ProductImage } from "./product-image";
import { RailScroller } from "./rail-scroller";
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
  // The home rail: the first six aisles this store stocks (#782), in platform order.
  const visible = all ? categories : categories.slice(0, 6);
  const tiles = visible.map((cat) => (
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
  ));
  return (
    <section data-testid="category-mosaic" aria-label="Store aisles">
      {/* The aisles page shows every aisle at once, under the page's own heading. */}
      {all ? (
        <div className="sf-aisle-grid">{tiles}</div>
      ) : (
        <RailScroller className="sf-category-rail" label="Aisles" title="Aisles full of home" description="The staples you know. A few new favorites." href="/categories" hrefLabel="See all aisles">
          {tiles}
        </RailScroller>
      )}
    </section>
  );
}
