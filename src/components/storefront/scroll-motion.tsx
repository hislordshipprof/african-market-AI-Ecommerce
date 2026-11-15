"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useReducedMotion } from "./use-reduced-motion";

/**
 * Calls `apply` with 0 when the element's top meets the viewport bottom and 1 when its bottom leaves the top,
 * once per frame while scrolling. Plain DOM, so these effects keep the animation library off the first load (#563).
 */
export function useScrollProgress(ref: RefObject<HTMLElement | null>, apply: (progress: number) => void, enabled: boolean) {
  const latest = useRef(apply);
  useEffect(() => { latest.current = apply; });
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const span = innerHeight + rect.height;
      latest.current(Math.min(1, Math.max(0, (innerHeight - rect.top) / span)));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); removeEventListener("scroll", schedule); removeEventListener("resize", schedule); };
  }, [ref, enabled]);
}

export function SectionReveal({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className} data-sf-reveal>
    {children}
  </div>;
}

export function ParallaxImage({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useScrollProgress(ref, progress => {
    if (image.current) image.current.style.transform = `translateY(${-20 + 40 * progress}px)`;
  }, !reduced);
  useEffect(() => { if (reduced && image.current) image.current.style.transform = "none"; }, [reduced]);
  return <div ref={ref} className="sf-parallax-frame"><div ref={image} className="sf-parallax-image" style={{ transform: "translateY(-20px)" }}>{children}</div></div>;
}

export function CountUp({ value, suffix = "" }: { value: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const element = ref.current;
    if (!element || reduced || !("IntersectionObserver" in window)) return;
    let frame = 0;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      const start = performance.now();
      // 1.2 s ease-out from 0, as before.
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / 1200);
        setShown(Math.round(value * (1 - (1 - t) ** 3)));
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }, { threshold: 0.2 });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [reduced, value]);
  return <span ref={ref} className="sf-counter" aria-label={`${value}${suffix}`}><span aria-hidden className="sf-counter-reserve">{value}{suffix}</span><span aria-hidden className="sf-counter-value">{shown}{suffix}</span></span>;
}

export function ShrinkingHeader({ children }: { children: ReactNode }) {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const update = () => setCompact(window.scrollY > 40);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return <header className="sf-header" data-compact={compact} data-testid="storefront-header">{children}</header>;
}
