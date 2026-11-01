"use client";

import { LazyMotion, domAnimation, MotionConfig } from "motion/react";
import { useEffect, type ReactNode } from "react";

export function StorefrontMotion({ children }: { children: ReactNode }) {
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let observer: IntersectionObserver | undefined;
    let mutations: MutationObserver | undefined;
    const stop = () => {
      observer?.disconnect();
      mutations?.disconnect();
      document.documentElement.classList.remove("sf-reveal-ready");
    };
    const start = () => {
      stop();
      if (preference.matches || !("IntersectionObserver" in window)) return;
      const seen = new WeakSet<Element>();
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.18) {
            entry.target.setAttribute("data-revealed", "true");
            observer?.unobserve(entry.target);
          }
        }
      }, { threshold: 0.18 });
      const scan = () => document.querySelectorAll<HTMLElement>("[data-sf-reveal]").forEach(element => {
        if (seen.has(element)) return;
        seen.add(element);
        const rect = element.getBoundingClientRect();
        // Never hide already painted content during hydration or client navigation.
        if (rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0) {
          element.dataset.revealed = "true";
        } else observer?.observe(element);
      });
      scan();
      document.documentElement.classList.add("sf-reveal-ready");
      mutations = new MutationObserver(scan);
      mutations.observe(document.body, { childList: true, subtree: true });
    };
    start();
    preference.addEventListener("change", start);
    return () => { stop(); preference.removeEventListener("change", start); };
  }, []);
  return <LazyMotion features={domAnimation}><MotionConfig reducedMotion="user">{children}</MotionConfig></LazyMotion>;
}
