"use client";
import { useEffect, useId, useRef, useState } from "react";
import { m, AnimatePresence, useInView, useReducedMotion } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play, ShieldCheck, Store, Truck } from "lucide-react";
import type { StorefrontBanner, StorefrontListing } from "@/lib/storefront/service";
import { editorial, photoOrFallback } from "@/lib/storefront/editorial";
import { canAutoplay, HERO_INTERVAL } from "@/lib/storefront/motion";
import { ProductImage } from "./product-image";

export function HeroCarousel({ banners, products = [], pickupMinutes = 30, pickupEnabled = true }: {
  banners: StorefrontBanner[]; products?: StorefrontListing[]; pickupMinutes?: number; pickupEnabled?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tabVisible, setTabVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const elapsed = useRef(0);
  const touch = useRef<number | null>(null);
  const ref = useRef<HTMLElement>(null);
  const visible = useInView(ref, { amount: 0.2 });
  const reduced = useReducedMotion();
  const badgeId = useId().replace(/:/g, "");
  const running = canAutoplay({ reduced, paused, hovered, focused, visible, tabVisible, slides: banners.length });
  useEffect(() => {
    const update = () => setTabVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (!running) return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      elapsed.current += now - previous;
      previous = now;
      if (elapsed.current >= HERO_INTERVAL) {
        elapsed.current = 0;
        setIndex(current => (current + 1) % banners.length);
      }
      setProgress(elapsed.current / HERO_INTERVAL);
    }, 60);
    return () => window.clearInterval(timer);
  }, [running, banners.length]);
  if (!banners.length) return null;
  const safeIndex = index % banners.length;
  const banner = banners[safeIndex];
  const subject = products[safeIndex % Math.max(1, products.length)];
  const go = (next: number) => { elapsed.current = 0; setProgress(0); setIndex((next + banners.length) % banners.length); };
  const enter = reduced ? false : { opacity: 0, y: 24 };
  return (
    <section ref={ref} className="sf-hero-wrap" data-testid="hero-carousel" data-autoplay={running ? "running" : "paused"}
      aria-roledescription="carousel" aria-label="Store offers"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}>
      <div className="sf-hero" tabIndex={0}
        onTouchStart={e => { touch.current = e.touches[0].clientX; }}
        onTouchEnd={e => { if (touch.current !== null) { const delta = e.changedTouches[0].clientX - touch.current; if (Math.abs(delta) > 45) go(safeIndex + (delta < 0 ? 1 : -1)); } touch.current = null; }}
        onKeyDown={e => {
          const next = { ArrowRight: safeIndex + 1, ArrowLeft: safeIndex - 1, Home: 0, End: banners.length - 1 }[e.key];
          if (next !== undefined) { e.preventDefault(); go(next); }
        }}>
        <AnimatePresence initial={false}>
          <m.div key={banner.id} className="sf-hero-slide" role="group" aria-roledescription="slide" aria-label={`${safeIndex + 1} of ${banners.length}`}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.65 }}>
            <div className="sf-hero-background" style={{ animationPlayState: running ? "running" : "paused" }}>
              <Image src={photoOrFallback(banner.imageUrl, [editorial.market, editorial.spices, editorial.grains][safeIndex % 3])} alt="" fill sizes="100vw" preload={safeIndex === 0} draggable={false} />
            </div>
            <div className="sf-hero-shade" />
            <span className="sf-hero-word" aria-hidden>{["HOME", "FRESH", "GATHER"][safeIndex % 3]}</span>
            <div className="sf-hero-inner sf-container">
              <m.div className="sf-hero-copy" initial={false} animate="show" variants={{ show: { transition: { staggerChildren: reduced ? 0 : 0.09 } } }}>
                <m.h2 data-testid="banner-title" initial={enter} variants={{ show: { opacity: 1, y: 0 } }}>{banner.title}</m.h2>
                {banner.subtitle && <m.p initial={enter} variants={{ show: { opacity: 1, y: 0 } }}>{banner.subtitle}</m.p>}
                {banner.ctaText && banner.ctaHref && <m.div initial={enter} variants={{ show: { opacity: 1, y: 0 } }}><Link href={banner.ctaHref} className="sf-button">{banner.ctaText}<ArrowRight size={18} aria-hidden /></Link></m.div>}
              </m.div>
              {subject?.imageUrl?.startsWith("/images/products/") && <m.div className="sf-hero-subject" initial={reduced ? false : { opacity: 0, x: 70, rotate: -7 }} animate={{ opacity: 1, x: 0, rotate: -4 }} transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 90, damping: 18 }}>
                <ProductImage src={subject.imageUrl} name={subject.displayName} sizes="(max-width:767px) 210px, 470px" />
                <span className="sf-hero-subject-label">{subject.altName || subject.displayName}</span>
              </m.div>}
              <div className="sf-glass-pill sf-glass-one"><Store size={18} aria-hidden />{pickupEnabled ? `Pickup in ${pickupMinutes} min` : "Your neighborhood favorites"}</div>
              <div className="sf-glass-pill sf-glass-two"><ShieldCheck size={18} aria-hidden />No swaps without your say</div>
              <svg className="sf-round-badge" style={{ animationPlayState: running ? "running" : "paused" }} viewBox="0 0 120 120" aria-hidden>
                <defs><path id={badgeId} d="M60,60m-44,0a44,44 0 1,1 88,0a44,44 0 1,1 -88,0" /></defs>
                <text><textPath href={`#${badgeId}`} textLength="276">FROM OUR SHELVES · TO YOUR KITCHEN · </textPath></text>
                <path d="M47 61h26m-12-12 12 12-12 12" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            </div>
          </m.div>
        </AnimatePresence>
        {banners.length > 1 && <div className="sf-hero-controls sf-container">
          <div className="sf-hero-dots">{banners.map((b, i) => <button key={b.id} type="button" className="sf-hero-dot" data-testid="carousel-dot" aria-current={i === safeIndex ? "true" : undefined} aria-label={`Go to slide ${i + 1}`} onClick={() => go(i)}><span><i style={{ transform: `scaleX(${i === safeIndex ? (reduced ? 1 : progress) : 0})` }} /></span></button>)}</div>
          <span className="sr-only" aria-live={running ? "off" : "polite"}>Slide {safeIndex + 1} of {banners.length}: {banner.title}</span>
          <div className="sf-hero-arrows">
            <button type="button" className="sf-round-button" aria-label={paused || reduced ? "Play slideshow" : "Pause slideshow"} aria-pressed={paused} disabled={!!reduced} onClick={() => setPaused(v => !v)}>{paused || reduced ? <Play size={17} /> : <Pause size={17} />}</button>
            <button type="button" className="sf-round-button" aria-label="Previous slide" onClick={() => go(safeIndex - 1)}><ChevronLeft size={18} /></button>
            <button type="button" className="sf-round-button" aria-label="Next slide" onClick={() => go(safeIndex + 1)}><ChevronRight size={18} /></button>
          </div>
        </div>}
      </div>
      <div className="sf-reassurance sf-container"><span><Store size={16} />Your neighborhood store, online</span><span><ShieldCheck size={16} />No swaps without your say</span><span><Truck size={16} />Local delivery & easy pickup</span></div>
      <Link href="/categories/spices-and-seasonings" className="sf-hero-offer"><strong>Make room for a little spice.</strong><span>Explore the pantry <ArrowRight size={16} /></span></Link>
    </section>
  );
}
