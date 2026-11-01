import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight } from "lucide-react";
import { categoryPhotos } from "@/lib/storefront/catalog";
import { editorial, photoOrFallback } from "@/lib/storefront/editorial";
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
    <section data-testid="category-mosaic" aria-labelledby="mosaic-heading">
      <SectionHeader
        id="mosaic-heading"
        title="Aisles full of home"
        description="The staples you know. A few new favorites."
        href={all ? undefined : "/categories"}
      />
      <div className="sf-mosaic">
        {visible.map((cat) => (
          <Link
            key={cat.id}
            href={`/categories/${cat.slug}`}
            className="sf-category-tile"
          >
            <Image
              src={photoOrFallback(
                cat.imageUrl,
                categoryPhotos[cat.slug] || editorial.market,
              )}
              alt=""
              fill
              sizes="(max-width:767px) 45vw, 300px"
            />
            <div className="sf-photo-scrim" />
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
}
