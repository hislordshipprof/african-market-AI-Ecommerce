"use client";
import { useRef, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

export function RailScroller({
  children,
  label,
  title,
  description,
  href,
}: {
  children: ReactNode;
  label: string;
  title: string;
  description?: string;
  href?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) =>
    ref.current?.scrollBy({
      left: dir * ref.current.clientWidth * 0.8,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  return (
    <div className="sf-rail">
      <div className="sf-rail-label">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
          {href && (
            <a href={href} className="sf-text-link">
              Shop the aisle <ArrowRight size={16} />
            </a>
          )}
        </div>
        <div className="sf-rail-arrows">
          <button
            type="button"
            className="sf-round-button"
            aria-label={`Scroll ${label} left`}
            onClick={() => scroll(-1)}
          >
            <ArrowLeft size={18} />
          </button>
          <button
            type="button"
            className="sf-round-button"
            aria-label={`Scroll ${label} right`}
            onClick={() => scroll(1)}
          >
            <ArrowRight size={18} />
          </button>
        </div>
      </div>
      <div
        ref={ref}
        className="sf-rail-scroll"
        data-testid="rail-scroll"
        tabIndex={0}
        role="region"
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            scroll(1);
          }
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            scroll(-1);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
