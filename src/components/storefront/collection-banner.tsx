import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { StorefrontCollection } from "@/lib/storefront/service";
import { editorial, photoOrFallback } from "@/lib/storefront/editorial";
import { ParallaxImage } from "./scroll-motion";

export function CollectionBanners({ collections }: { collections: StorefrontCollection[] }) {
  if (!collections.length) return null;
  return <section className="sf-collection-section" data-testid="collection-banners" aria-label="Meal inspiration">
    {/* Wraps instead of scrolling sideways: the product rail is the only sideways scroller (#862 AC6). */}
    <div className="sf-rail-label"><div><h2>Good meals start here</h2><p>A little inspiration for your next gathering.</p></div></div>
    <div className="sf-card-grid sf-collection-rail">
      {collections.map((col, i) => <Link key={col.id} href={"/collections/" + col.slug} className="sf-collection-card">
        <ParallaxImage><Image src={photoOrFallback(col.imageUrl, i % 2 ? editorial.spices : editorial.jollof)} alt="" fill sizes="(max-width:767px) 44vw, 320px" /></ParallaxImage>
        <div className="sf-photo-scrim" /><div><h3>{col.title}</h3>{col.subtitle && <p>{col.subtitle}</p>}<span className="sf-round-button"><ArrowUpRight size={20} aria-hidden /></span></div>
      </Link>)}
    </div>
  </section>;
}
