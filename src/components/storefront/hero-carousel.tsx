"use client";
import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Store,
  Truck,
} from "lucide-react";
import type { StorefrontBanner } from "@/lib/storefront/service";
import { editorial, photoOrFallback } from "@/lib/storefront/editorial";

export function HeroCarousel({ banners }: { banners: StorefrontBanner[] }) {
  const [index, setIndex] = useState(0);
  const reduced = useReducedMotion();
  if (!banners.length) return null;
  const safeIndex = index % banners.length;
  const banner = banners[safeIndex];
  const go = (next: number) =>
    setIndex((next + banners.length) % banners.length);
  const fallback = [editorial.jollof, editorial.spices, editorial.market][
    safeIndex % 3
  ];
  return (
    <section
      className="sf-hero-wrap sf-container"
      data-testid="hero-carousel"
      aria-roledescription="carousel"
      aria-label="Store offers"
    >
      <div className="sf-hero-grid">
        <div
          className="sf-hero"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              go(safeIndex + 1);
            }
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              go(safeIndex - 1);
            }
            if (e.key === "Home") {
              e.preventDefault();
              go(0);
            }
            if (e.key === "End") {
              e.preventDefault();
              go(banners.length - 1);
            }
          }}
        >
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              key={banner.id}
              className="sf-hero-slide"
              role="group"
              aria-roledescription="slide"
              aria-label={`${safeIndex + 1} of ${banners.length}`}
              initial={reduced ? false : { opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? { opacity: 1 } : { opacity: 0, x: -24 }}
              transition={{
                duration: reduced ? 0 : 0.4,
                ease: [0.45, 0, 0.05, 1],
              }}
              drag={banners.length > 1 ? "x" : false}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={reduced ? 0 : 0.1}
              onDragEnd={(_, info) => {
                if (info.offset.x < -45) go(safeIndex + 1);
                if (info.offset.x > 45) go(safeIndex - 1);
              }}
            >
              <div className="sf-hero-copy">
                <h2 data-testid="banner-title">{banner.title}</h2>
                {banner.subtitle && <p>{banner.subtitle}</p>}
                {banner.ctaText && banner.ctaHref && (
                  <Link href={banner.ctaHref} className="sf-button">
                    {banner.ctaText}
                    <ArrowRight size={16} aria-hidden />
                  </Link>
                )}
              </div>
              <div className="sf-hero-photo">
                <Image
                  src={photoOrFallback(banner.imageUrl, fallback)}
                  alt=""
                  fill
                  sizes="(max-width:767px) 45vw, (max-width:1280px) 32vw, 440px"
                  priority={safeIndex === 0}
                  draggable={false}
                />
              </div>
            </motion.div>
          </AnimatePresence>
          {banners.length > 1 && (
            <div className="sf-hero-controls">
              <div className="sf-hero-dots">
                {banners.map((b, i) => (
                  <button
                    key={b.id}
                    type="button"
                    className="sf-hero-dot"
                    data-testid="carousel-dot"
                    aria-current={i === safeIndex ? "true" : undefined}
                    aria-label={`Go to slide ${i + 1}`}
                    onClick={() => go(i)}
                  >
                    <span />
                  </button>
                ))}
              </div>
              <span className="sr-only" aria-live="polite">
                Slide {safeIndex + 1} of {banners.length}: {banner.title}
              </span>
              <div className="sf-hero-arrows">
                <button
                  type="button"
                  className="sf-round-button"
                  aria-label="Previous slide"
                  onClick={() => go(safeIndex - 1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  type="button"
                  className="sf-round-button"
                  aria-label="Next slide"
                  onClick={() => go(safeIndex + 1)}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>
          )}
        </div>
        <Link href="/categories/spices-and-seasonings" className="sf-offer">
          <Image
            src={editorial.spices}
            alt="Bowls of spices and peppers"
            fill
            sizes="(max-width:767px) 1px, 400px"
            priority
          />
          <div className="sf-photo-scrim" />
          <div className="sf-offer-copy">
            <h3>
              Big flavor.
              <br />
              Small essentials.
            </h3>
            <p>Build your spice cupboard, one familiar favorite at a time.</p>
            <span className="sf-offer-link">
              Explore the pantry <ArrowRight size={18} />
            </span>
          </div>
        </Link>
      </div>
      <div className="sf-reassurance">
        <span>
          <Store size={16} />
          Your neighborhood store, online
        </span>
        <span>
          <ShieldCheck size={16} />
          No swaps without your say
        </span>
        <span>
          <Truck size={16} />
          Local delivery & easy pickup
        </span>
      </div>
    </section>
  );
}
