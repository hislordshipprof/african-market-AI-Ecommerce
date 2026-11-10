"use client";
import { useRef, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

export function RailScroller({
  children,
  label,
  title,
  description,
  href,
  className = "",
}: {
  children: ReactNode;
  label: string;
  title: string;
  description?: string;
  href?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const scroll = (dir: number) =>
    ref.current?.scrollBy({
      left: dir * ref.current.clientWidth * 0.8,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  return (
    <div className={`sf-rail ${className}`}>
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
        onPointerDown={e => {
          if (e.pointerType !== "mouse" || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
          drag.current = { x: e.clientX, left: e.currentTarget.scrollLeft, moved: false };
        }}
        onPointerMove={e => {
          if (!drag.current) return;
          const delta = e.clientX - drag.current.x;
          if (Math.abs(delta) > 6) {
            drag.current.moved = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.style.scrollSnapType = "none";
            e.currentTarget.scrollLeft = drag.current.left - delta;
          }
        }}
        onPointerUp={e => { e.currentTarget.style.scrollSnapType = ""; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => { drag.current = null; if (ref.current) ref.current.style.scrollSnapType = ""; }}
        onPointerLeave={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) drag.current = null; }}
        onClickCapture={e => { if (drag.current?.moved) { e.preventDefault(); e.stopPropagation(); } drag.current = null; }}
        onDragStart={e => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Home" || e.key === "End") {
            e.preventDefault();
            const rail = e.currentTarget;
            // A jump during a smooth arrow scroll gets pulled back by mandatory snapping mid-animation, so snap waits two frames.
            rail.style.scrollSnapType = "none";
            rail.scrollTo({ left: e.key === "Home" ? 0 : rail.scrollWidth, behavior: "instant" });
            requestAnimationFrame(() => requestAnimationFrame(() => { rail.style.scrollSnapType = ""; }));
          }
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
