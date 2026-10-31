"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { StorefrontListing } from "@/lib/storefront/service";
import { ListingCard } from "./listing-card";

export function ProductRail({
  title,
  listings,
  seeAllHref,
}: {
  title: string;
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
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  }

  if (listings.length === 0) return null;

  return (
    <section data-testid="product-rail" aria-label={title}>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2
          className="font-display text-ink"
          style={{ fontSize: "22px", fontWeight: 700, lineHeight: 1.2 }}
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
          className="flex gap-3 overflow-x-auto scroll-smooth snap-x snap-mandatory [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
        >
          {listings.map((listing) => (
            <div
              key={listing.id}
              className="w-40 shrink-0 snap-start sm:w-48"
            >
              <ListingCard listing={listing} />
            </div>
          ))}
        </div>

        {canScrollLeft && (
          <button
            type="button"
            onClick={() => scroll(-1)}
            className="absolute -left-3 top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-surface shadow-md transition-opacity hover:bg-raised md:group-hover/rail:flex"
            aria-label="Scroll left"
          >
            <ChevronLeft className="h-5 w-5 text-ink" />
          </button>
        )}
        {canScrollRight && (
          <button
            type="button"
            onClick={() => scroll(1)}
            className="absolute -right-3 top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-surface shadow-md transition-opacity hover:bg-raised md:group-hover/rail:flex"
            aria-label="Scroll right"
          >
            <ChevronRight className="h-5 w-5 text-ink" />
          </button>
        )}
      </div>
    </section>
  );
}
