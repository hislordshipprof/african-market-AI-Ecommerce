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

function BannerContent({ banner }: { banner: StorefrontBanner }) {
  return (
    <>
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${banner.imageUrl})` }}
      />
      <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-black/30 to-transparent" />
      <div className="relative flex h-full items-center px-6 sm:px-8">
        <div className="max-w-md">
          <h2
            className="font-display text-white"
            style={{
              fontSize: "clamp(20px, 3.5vw, 36px)",
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
              className="mt-3 inline-flex h-11 items-center rounded-pill bg-white px-6 font-label text-sm font-semibold text-primary-deep transition-opacity hover:opacity-90"
            >
              {banner.ctaText}
            </Link>
          )}
        </div>
      </div>
    </>
  );
}

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

  const safeIndex = index >= banners.length ? 0 : index;
  const banner = banners[safeIndex];
  const nextBanner = banners[(safeIndex + 1) % banners.length];
  const hasMultiple = banners.length > 1;

  return (
    <section
      data-testid="hero-carousel"
      className="relative w-full bg-raised"
    >
      <div className="mx-auto flex max-w-6xl gap-3 px-4 py-3 sm:px-6">
        {/* Main carousel panel */}
        <div
          className="relative w-full overflow-hidden rounded-lg lg:w-2/3"
          style={{ aspectRatio: "16/9", maxHeight: 380 }}
        >
          <AnimatePresence initial={false} custom={dir} mode="popLayout">
            <motion.div
              key={banner.id}
              custom={dir}
              variants={variants}
              initial="enter"
              animate="center"
              exit="exit"
              drag={hasMultiple ? "x" : false}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.12}
              onDragEnd={(_e, info) => {
                const swipe = info.offset.x;
                if (swipe < -50) go(safeIndex + 1, 1);
                else if (swipe > 50) go(safeIndex - 1, -1);
              }}
              transition={
                reduced
                  ? { duration: 0 }
                  : { duration: 0.4, ease: [0.4, 0.4, 0, 1] }
              }
              className="absolute inset-0"
            >
              <BannerContent banner={banner} />
            </motion.div>
          </AnimatePresence>

          {hasMultiple && (
            <>
              <button
                type="button"
                onClick={() => go(safeIndex - 1, -1)}
                className="absolute left-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/30 text-white backdrop-blur-sm transition-colors hover:bg-black/50 md:flex"
                aria-label="Previous slide"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => go(safeIndex + 1, 1)}
                className="absolute right-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/30 text-white backdrop-blur-sm transition-colors hover:bg-black/50 md:flex"
                aria-label="Next slide"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </>
          )}
        </div>

        {/* Side tile — desktop only */}
        {hasMultiple && (
          <button
            type="button"
            onClick={() => go(safeIndex + 1, 1)}
            className="relative hidden w-1/3 overflow-hidden rounded-lg lg:block"
            aria-label={`Next: ${nextBanner.title}`}
          >
            <div
              className="absolute inset-0 bg-cover bg-center transition-all duration-300 hover:scale-[1.03]"
              style={{
                backgroundImage: `url(${nextBanner.imageUrl})`,
                transitionTimingFunction: "var(--ease-std)",
              }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
            <div className="relative flex h-full flex-col justify-end p-5">
              <span className="font-display text-lg font-bold leading-tight text-white">
                {nextBanner.title}
              </span>
            </div>
          </button>
        )}
      </div>

      {/* Dots — below the panels */}
      {hasMultiple && (
        <div className="flex justify-center gap-2 pb-3">
          {banners.map((b, i) => (
            <button
              key={b.id}
              type="button"
              data-testid="carousel-dot"
              onClick={() => go(i, i > safeIndex ? 1 : -1)}
              aria-current={i === safeIndex ? "true" : undefined}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center"
              aria-label={`Go to slide ${i + 1}`}
            >
              <span
                className={`block h-2 rounded-pill transition-all ${
                  i === safeIndex
                    ? "w-6 bg-primary"
                    : "w-2 bg-muted/40 hover:bg-muted/60"
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
