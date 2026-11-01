import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { StorefrontCollection } from "@/lib/storefront/service";
import { editorial, photoOrFallback } from "@/lib/storefront/editorial";
import { SectionHeader } from "./primitives";
export function CollectionBanners({
  collections,
}: {
  collections: StorefrontCollection[];
}) {
  if (!collections.length) return null;
  return (
    <section
      data-testid="collection-banners"
      aria-labelledby="collections-heading"
    >
      <SectionHeader
        id="collections-heading"
        title="Good meals start here"
        description="A little inspiration for your next gathering."
      />
      <div className="sf-collections">
        {collections.map((col, i) => (
          <Link
            key={col.id}
            href={`/collections/${col.slug}`}
            className="sf-collection-card"
          >
            <Image
              src={photoOrFallback(
                col.imageUrl,
                i % 2 ? editorial.spices : editorial.jollof,
              )}
              alt=""
              fill
              sizes="(max-width:767px) 100vw, 600px"
            />
            <div className="sf-photo-scrim" />
            <div>
              <h3>{col.title}</h3>
              {col.subtitle && <p>{col.subtitle}</p>}
              <span className="sf-round-button">
                <ArrowUpRight size={20} aria-hidden />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
