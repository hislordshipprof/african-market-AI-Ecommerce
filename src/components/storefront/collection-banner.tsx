"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, ArrowLeft, ArrowRight } from "lucide-react";
import type { StorefrontCollection } from "@/lib/storefront/service";
import { editorial, photoOrFallback } from "@/lib/storefront/editorial";
import { SectionHeader } from "./primitives";
import { ParallaxImage } from "./scroll-motion";
export function CollectionBanners({ collections }: { collections: StorefrontCollection[] }) {
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const pointerSelection = useRef<number | null>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width:767px)");
    const sync = () => {
      if (!query.matches || !ref.current) return;
      const cards = Array.from(ref.current.children) as HTMLElement[];
      const left = ref.current.scrollLeft;
      const index = cards.reduce((best, card, i) => Math.abs(card.offsetLeft - ref.current!.offsetLeft - left) < Math.abs(cards[best].offsetLeft - ref.current!.offsetLeft - left) ? i : best, 0);
      setActive(index);
    };
    query.addEventListener("change", sync);
    const rail = ref.current;
    rail?.addEventListener("scroll", sync, { passive: true });
    return () => { query.removeEventListener("change", sync); rail?.removeEventListener("scroll", sync); };
  }, []);
  if (!collections.length) return null;
  const go = (next: number) => {
    const index = Math.max(0, Math.min(collections.length - 1, next));
    setActive(index);
    if (window.matchMedia("(max-width:767px)").matches) {
      const card = ref.current?.children[index] as HTMLElement | undefined;
      ref.current?.scrollTo({ left: card ? card.offsetLeft - ref.current.offsetLeft : 0, behavior: window.matchMedia("(prefers-reduced-motion:reduce)").matches ? "instant" : "smooth" });
    }
  };
  return <section className="sf-collection-section" data-testid="collection-banners" aria-label="Meal inspiration" aria-roledescription="carousel">
    <SectionHeader id="collections-heading" title="Good meals start here" description="A little inspiration for your next gathering." />
    <div className="sf-coverflow" ref={ref} data-edge={active === 0 ? "start" : active === collections.length - 1 ? "end" : undefined} tabIndex={0} onKeyDown={e => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); go(active + (e.key === "ArrowRight" ? 1 : -1)); } if (e.key === "Home") { e.preventDefault(); go(0); } if (e.key === "End") { e.preventDefault(); go(collections.length - 1); } }}>
      {collections.map((col, i) => <Link key={col.id} href={`/collections/${col.slug}`} className="sf-collection-card" data-active={i === active}
        style={{ "--offset": i - active, "--recede": Math.min(Math.abs(i - active), 3), "--direction": Math.sign(i - active) } as React.CSSProperties}
        onPointerDown={() => { pointerSelection.current = active; }} onFocus={() => { if (pointerSelection.current === null) setActive(i); }}
        onClick={e => { const prior = pointerSelection.current ?? active; pointerSelection.current = null; if (i !== prior && !e.metaKey && !e.ctrlKey && window.matchMedia("(min-width:768px)").matches) { e.preventDefault(); go(i); } }} aria-label={`${col.title}${i !== active ? ", select collection" : ""}`}>
        <ParallaxImage><Image src={photoOrFallback(col.imageUrl, i % 2 ? editorial.spices : editorial.jollof)} alt="" fill sizes="(max-width:767px) 85vw, 600px" /></ParallaxImage>
        <div className="sf-photo-scrim" /><div><h3>{col.title}</h3>{col.subtitle && <p>{col.subtitle}</p>}<span className="sf-round-button"><ArrowUpRight size={20} aria-hidden /></span></div>
      </Link>)}
    </div>
    <div className="sf-coverflow-controls"><button className="sf-round-button" aria-label="Previous collection" disabled={active === 0} onClick={() => go(active - 1)}><ArrowLeft size={18} /></button><span aria-live="polite">{active + 1} / {collections.length}</span><button className="sf-round-button" aria-label="Next collection" disabled={active === collections.length - 1} onClick={() => go(active + 1)}><ArrowRight size={18} /></button></div>
  </section>;
}
