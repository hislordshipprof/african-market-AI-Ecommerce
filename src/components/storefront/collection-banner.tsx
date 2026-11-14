import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { StorefrontCollection } from "@/lib/storefront/service";
import { editorial, photoOrFallback } from "@/lib/storefront/editorial";
import { RailScroller } from "./rail-scroller";
import { ParallaxImage } from "./scroll-motion";

export function CollectionBanners({ collections }: { collections: StorefrontCollection[] }) {
  if (!collections.length) return null;
  return <section className="sf-collection-section" data-testid="collection-banners" aria-label="Meal inspiration">
    <RailScroller className="sf-collection-rail" label="Collections" title="Good meals start here" description="A little inspiration for your next gathering.">
      {collections.map((col, i) => <Link key={col.id} href={"/collections/" + col.slug} className="sf-collection-card sf-rail-item">
        <ParallaxImage><Image src={photoOrFallback(col.imageUrl, i % 2 ? editorial.spices : editorial.jollof)} alt="" fill sizes="(max-width:767px) 44vw, 320px" /></ParallaxImage>
        <div className="sf-photo-scrim" /><div><h3>{col.title}</h3>{col.subtitle && <p>{col.subtitle}</p>}<span className="sf-round-button"><ArrowUpRight size={20} aria-hidden /></span></div>
      </Link>)}
    </RailScroller>
  </section>;
}
