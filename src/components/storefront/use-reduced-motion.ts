"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(listener: () => void) {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** The shopper's reduced-motion setting, without loading the animation library (#563). Server render: false. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}
