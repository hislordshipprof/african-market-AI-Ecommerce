"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play, ShieldCheck, Store, Truck } from "lucide-react";
import type { StorefrontBanner, StorefrontListing } from "@/lib/storefront/service";
import { editorial, photoOrFallback } from "@/lib/storefront/editorial";
import { canAutoplay, HERO_INTERVAL } from "@/lib/storefront/motion";
import { ProductImage } from "./product-image";
import { useReducedMotion } from "./use-reduced-motion";

// Matches the exit fade in motion.css (.sf-hero-slide[data-leaving]).
const SLIDE_FADE_MS = 650;

/** True once a fifth of the element is on screen. */
function useInView(ref: RefObject<HTMLElement | null>, amount: number) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: amount });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, amount]);
  return inView;
}

export function HeroCarousel({ banners, products = [], pickupMinutes = 30, pickupEnabled = true }: {
  banners: StorefrontBanner[]; products?: StorefrontListing[]; pickupMinutes?: number; pickupEnabled?: boolean;
}) {
  const [index, setIndex] = useState(0);
  // The slide fading out, and whether any slide has changed yet (the first slide never animates in).
  const [leaving, setLeaving] = useState<number | null>(null);
  const [changed, setChanged] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tabVisible, setTabVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const elapsed = useRef(0);
  const indexRef = useRef(0);
  const touch = useRef<number | null>(null);
  const ref = useRef<HTMLElement>(null);
  const visible = useInView(ref, 0.2);
  const reduced = useReducedMotion();
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
        const from = indexRef.current;
        show(from);
        setIndex((from + 1) % banners.length);
      }
      setProgress(elapsed.current / HERO_INTERVAL);
    }, 60);
    return () => window.clearInterval(timer);
  }, [running, banners.length]);
  useEffect(() => {
    if (leaving === null) return;
    const timer = window.setTimeout(() => setLeaving(null), SLIDE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  function show(from: number) {
    setLeaving(from);
    setChanged(true);
  }
  const safeIndex = banners.length ? index % banners.length : 0;
  useEffect(() => { indexRef.current = safeIndex; }, [safeIndex]);
  if (!banners.length) return null;
  const banner = banners[safeIndex];
  const leavingIndex = leaving === null ? null : leaving % banners.length;
  const go = (next: number) => {
    const target = (next + banners.length) % banners.length;
    elapsed.current = 0; setProgress(0);
    if (target !== safeIndex) show(safeIndex);
    setIndex(target);
  };
  const slide = (i: number, state: "current" | "leaving") => {
    const item = banners[i];
    const itemSubject = products[i % Math.max(1, products.length)];
    return (
          <div key={item.id} className="sf-hero-slide" role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${banners.length}`}
            aria-hidden={state === "leaving" || undefined} data-leaving={state === "leaving" || undefined} data-enter={(state === "current" && changed) || undefined}>
            <div className="sf-hero-background" style={{ animationPlayState: running ? "running" : "paused" }}>
              <Image src={photoOrFallback(item.imageUrl, [editorial.market, editorial.spices, editorial.grains][i % 3])} alt="" fill sizes="100vw" preload={i === 0 && !changed} fetchPriority={i === 0 && !changed ? "high" : undefined} draggable={false} />
            </div>
            <div className="sf-hero-shade" />
            <div className="sf-hero-inner sf-container">
              <div className="sf-hero-copy">
                <h2 data-testid={state === "current" ? "banner-title" : undefined}>{item.title}</h2>
                {item.subtitle && <p>{item.subtitle}</p>}
                {item.ctaText && item.ctaHref && <div><Link href={item.ctaHref} className="sf-button" tabIndex={state === "leaving" ? -1 : undefined}>{item.ctaText}<ArrowRight size={18} aria-hidden /></Link></div>}
              </div>
              {itemSubject?.imageUrl?.startsWith("/images/products/") && <div className="sf-hero-subject">
                <ProductImage src={itemSubject.imageUrl} name={itemSubject.displayName} sizes="(max-width:767px) 210px, 470px" />
                <span className="sf-hero-subject-label">{itemSubject.altName || itemSubject.displayName}</span>
              </div>}
              <div className="sf-glass-pill sf-glass-one"><Store size={18} aria-hidden />{pickupEnabled ? `Pickup in ${pickupMinutes} min` : "Your neighborhood favorites"}</div>
              <div className="sf-glass-pill sf-glass-two"><ShieldCheck size={18} aria-hidden />We ask before any swap</div>
            </div>
          </div>
    );
  };
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
        {/* One keyed list, so the outgoing slide keeps its element (and its animations) while it fades. */}
        {(leavingIndex !== null && leavingIndex !== safeIndex ? [leavingIndex, safeIndex] : [safeIndex])
          .map(i => slide(i, i === safeIndex ? "current" : "leaving"))}
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
      <div className="sf-reassurance sf-container"><span><Store size={16} />Your neighborhood store, online</span><span><ShieldCheck size={16} />We ask before any swap</span><span><Truck size={16} />Local delivery & easy pickup</span></div>
    </section>
  );
}
