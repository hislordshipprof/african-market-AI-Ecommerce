"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { m, useInView, useReducedMotion, useScroll, useTransform, animate } from "motion/react";

export function SectionReveal({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className} data-sf-reveal>
    {children}
  </div>;
}

export function ParallaxImage({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [-20, 20]);
  return <div ref={ref} className="sf-parallax-frame"><m.div className="sf-parallax-image" style={{ y: reduced ? 0 : y }}>{children}</m.div></div>;
}

export function CountUp({ value, suffix = "" }: { value: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const entered = useInView(ref, { once: true, amount: 0.2 });
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (!entered || reduced !== false) return;
    const animation = animate(0, value, { duration: 1.2, ease: "easeOut", onUpdate: n => setShown(Math.round(n)) });
    return () => animation.stop();
  }, [entered, reduced, value]);
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
