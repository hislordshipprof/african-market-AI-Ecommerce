"use client";

import {
  Suspense,
  lazy,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Image from "next/image";
import { motion } from "motion/react";
import posterSrc from "../../../public/images/market-spices-poster.jpg";

const LazyMarketScene = lazy(() =>
  import("./market-scene").then((m) => ({ default: m.MarketScene })),
);

function canShowScene(): boolean {
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const narrow = window.innerWidth < 768;
  const saveData = (
    navigator as unknown as { connection?: { saveData?: boolean } }
  ).connection?.saveData;
  return !reducedMotion && !narrow && !saveData;
}

function subscribeToSceneConditions(callback: () => void) {
  const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
  mql.addEventListener("change", callback);
  window.addEventListener("resize", callback);
  return () => {
    mql.removeEventListener("change", callback);
    window.removeEventListener("resize", callback);
  };
}

const SERVER_SNAPSHOT = false;
function getServerSnapshot() {
  return SERVER_SNAPSHOT;
}

export function StorySurface({ children }: { children: ReactNode }) {
  const showScene = useSyncExternalStore(
    subscribeToSceneConditions,
    canShowScene,
    getServerSnapshot,
  );

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden p-4">
      {/* Poster photograph — first paint, always visible */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
      >
        <Image
          src={posterSrc}
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover"
          placeholder="blur"
        />
        <div className="absolute inset-0 bg-gradient-to-br from-black/50 via-black/30 to-transparent dark:from-black/70 dark:via-black/50" />
      </div>

      {/* 3D scene — lazy, desktop only, skipped on reduced-motion & save-data */}
      {showScene && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <Suspense fallback={null}>
            <LazyMarketScene />
          </Suspense>
        </div>
      )}

      {/* Form panel with entrance motion */}
      <motion.div
        className="relative z-10 w-full max-w-sm"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.4, 0.4, 0, 1] }}
      >
        {children}
      </motion.div>
    </main>
  );
}
