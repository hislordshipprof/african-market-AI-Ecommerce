"use client";

import { useState, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { StorefrontBanner } from "@/lib/storefront/service";

const variants = {
  enter: (dir: number) => ({ x: dir > 0 ? "100%" : "-100%", opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? "-100%" : "100%", opacity: 0 }),
};

export function HeroCarousel({ banners }: { banners: StorefrontBanner[] }) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);

  const go = useCallback(
    (next: number, direction: number) => {
      setDir(direction);
      setIndex(((next % banners.length) + banners.length) % banners.length);
    },
    [banners.length],
  );

  if (banners.length === 0) return null;

  const banner = banners[index];

  return (
    <section
      data-testid="hero-carousel"
      className="relative w-full overflow-hidden bg-raised"
      style={{ aspectRatio: "16/9", maxHeight: 400 }}
    >
      <AnimatePresence initial={false} custom={dir} mode="popLayout">
        <motion.div
          key={banner.id}
          custom={dir}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          drag={banners.length > 1 ? "x" : false}
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.12}
          onDragEnd={(_e, info) => {
            const swipe = info.offset.x;
            if (swipe < -50) go(index + 1, 1);
            else if (swipe > 50) go(index - 1, -1);
          }}
          transition={
            reduced ? { duration: 0 } : { duration: 0.4, ease: [0.4, 0.4, 0, 1] }
          }
          className="absolute inset-0"
        >
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${banner.imageUrl})` }}
          />
          <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-black/30 to-transparent" />

          <div className="relative flex h-full items-center px-6 sm:px-12">
            <div className="max-w-md">
              <h2
                className="font-display text-white"
                style={{
                  fontSize: "clamp(24px, 4vw, 40px)",
                  fontWeight: 700,
                  lineHeight: 1.1,
                }}
              >
                {banner.title}
              </h2>
              {banner.subtitle && (
                <p className="mt-2 font-body text-sm text-white/80 sm:text-base">
                  {banner.subtitle}
                </p>
              )}
              {banner.ctaText && banner.ctaHref && (
                <Link
                  href={banner.ctaHref}
                  className="mt-4 inline-flex h-11 items-center rounded-pill bg-white px-6 font-label text-sm font-semibold text-primary-deep transition-opacity hover:opacity-90"
                >
                  {banner.ctaText}
                </Link>
              )}
            </div>
          </div>
        </motion.div>
      </AnimatePresence>

      {banners.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => go(index - 1, -1)}
            className="absolute left-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/30 text-white backdrop-blur-sm transition-colors hover:bg-black/50 md:flex"
            aria-label="Previous slide"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => go(index + 1, 1)}
            className="absolute right-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/30 text-white backdrop-blur-sm transition-colors hover:bg-black/50 md:flex"
            aria-label="Next slide"
          >
            <ChevronRight className="h-5 w-5" />
          </button>

          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-2">
            {banners.map((b, i) => (
              <button
                key={b.id}
                type="button"
                data-testid="carousel-dot"
                onClick={() => go(i, i > index ? 1 : -1)}
                aria-current={i === index ? "true" : undefined}
                className={`min-h-[44px] min-w-[44px] flex items-center justify-center`}
                aria-label={`Go to slide ${i + 1}`}
              >
                <span
                  className={`block h-2 rounded-pill transition-all ${
                    i === index
                      ? "w-6 bg-white"
                      : "w-2 bg-white/50 hover:bg-white/70"
                  }`}
                />
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
