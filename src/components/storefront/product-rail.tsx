"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { StorefrontListing } from "@/lib/storefront/service";
import { ListingCard } from "./listing-card";

export function ProductRail({
  title,
  categorySlug,
  listings,
  seeAllHref,
}: {
  title: string;
  categorySlug?: string;
  listings: StorefrontListing[];
  seeAllHref?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    checkScroll();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", checkScroll, { passive: true });
    const ro = new ResizeObserver(checkScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", checkScroll);
      ro.disconnect();
    };
  }, [checkScroll]);

  function scroll(direction: number) {
    const el = scrollRef.current;
    if (!el) return;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({
      left: direction * el.clientWidth * 0.8,
      behavior: prefersReduced ? "instant" : "smooth",
    });
  }

  if (listings.length === 0) return null;

  return (
    <section data-testid="product-rail" aria-label={title}>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2
          className="font-display text-[22px] font-bold leading-[1.2] text-ink"
        >
          {title}
        </h2>
        {seeAllHref && (
          <Link
            href={seeAllHref}
            className="shrink-0 font-label text-sm font-semibold text-primary hover:underline"
          >
            See all &rarr;
          </Link>
        )}
      </div>

      <div className="group/rail relative">
        <div
          ref={scrollRef}
          data-testid="rail-scroll"
          className="flex gap-3 overflow-x-auto scroll-smooth snap-x snap-mandatory motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
        >
          {listings.map((listing) => (
            <div
              key={listing.id}
              className="w-[42%] shrink-0 snap-start sm:w-48"
            >
              <ListingCard listing={listing} categorySlug={categorySlug} />
            </div>
          ))}
        </div>

        {canScrollLeft && (
          <button
            type="button"
            onClick={() => scroll(-1)}
            className="absolute -left-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-surface transition-opacity hover:bg-raised focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 md:group-hover/rail:flex"
            aria-label="Scroll left"
          >
            <ChevronLeft className="h-5 w-5 text-ink" />
          </button>
        )}
        {canScrollRight && (
          <button
            type="button"
            onClick={() => scroll(1)}
            className="absolute -right-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-surface transition-opacity hover:bg-raised focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 md:group-hover/rail:flex"
            aria-label="Scroll right"
          >
            <ChevronRight className="h-5 w-5 text-ink" />
          </button>
        )}
      </div>
    </section>
  );
}
