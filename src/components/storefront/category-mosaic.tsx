import Link from "next/link";
import { ArrowUpRight, LayoutGrid } from "lucide-react";
import { categoryPhotos } from "@/lib/storefront/catalog";
import { storefrontPhoto } from "@/lib/storefront/images";
import { ProductImage } from "./product-image";
import { AislesOpener } from "./aisle-menu";
interface MosaicCategory {
  id: string;
  name: string;
  slug: string;
  localName: string | null;
  imageUrl: string | null;
}
const HOME_AISLES = 11;

export function CategoryMosaic({
  categories,
  all = false,
}: {
  categories: MosaicCategory[];
  all?: boolean;
}) {
  if (!categories.length) return null;
  const photo = (cat: MosaicCategory) =>
    storefrontPhoto(cat.imageUrl) || (categoryPhotos[cat.slug]?.startsWith("/images/products/") ? categoryPhotos[cat.slug] : undefined);
  // The aisles page shows every aisle at once, under the page's own heading.
  if (all)
    return (
      <section data-testid="category-mosaic" aria-label="Store aisles">
        <div className="sf-aisle-grid">
          {categories.map((cat) => (
            <Link
              key={cat.id}
              href={`/categories/${cat.slug}`}
              className="sf-category-tile"
              aria-label={cat.localName ? `${cat.name}, ${cat.localName}` : cat.name}
            >
              <ProductImage src={photo(cat)} name={cat.name} category={cat.slug} sizes="(max-width:767px) 44vw, 320px" />
              <div>
                <span>
                  {cat.localName && <small>{cat.localName}</small>}
                  <strong>{cat.name}</strong>
                </span>
                <ArrowUpRight size={20} aria-hidden />
              </div>
            </Link>
          ))}
        </div>
      </section>
    );
  // Home (#862): two rows of aisle cards, no sideways scroll; the last card opens the whole aisle tree.
  return (
    <section data-testid="category-mosaic" aria-labelledby="home-aisles-title" className="sf-home-aisles">
      <h2 id="home-aisles-title">Shop by aisle</h2>
      <ul className="sf-aisle-cards">
        {categories.slice(0, HOME_AISLES).map((cat) => (
          <li key={cat.id}>
            <Link href={`/categories/${cat.slug}`} className="sf-aisle-card">
              <span className="sf-aisle-card-photo">
                <ProductImage src={photo(cat)} name={cat.name} category={cat.slug} sizes="48px" />
              </span>
              <span>{cat.name}</span>
            </Link>
          </li>
        ))}
        <li>
          <AislesOpener className="sf-aisle-card sf-aisle-card-all">
            <LayoutGrid size={22} aria-hidden />
            <span>All {categories.length} aisles</span>
          </AislesOpener>
        </li>
      </ul>
    </section>
  );
}
