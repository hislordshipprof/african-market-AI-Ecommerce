"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** Audit row ids this tab has already shown. The router's Back/Forward cache replays a render with the same id. */
const shown = new Set<string>();

/**
 * Shows the detail only for a render whose audit row (`viewId`) is new to this tab. A replayed render
 * (Back, Forward) is hidden and fetched again, so the server writes a new audit row before the data shows.
 * The page is keyed on `viewId`, so the fresh render mounts a new gate.
 */
export function AuditedView({ viewId, children }: { viewId: string; children: React.ReactNode }) {
  const router = useRouter();
  const [replayed, setReplayed] = useState(() => shown.has(viewId));
  const own = useRef(false);

  useEffect(() => {
    if (shown.has(viewId) && !own.current) {
      setReplayed(true);
      router.refresh();
      return;
    }
    shown.add(viewId);
    own.current = true;
    // A page restored from the browser's back-forward cache runs no React code; reload it.
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, [viewId, router]);

  if (replayed) return <p role="status" className="mx-auto max-w-5xl px-4 py-8 text-muted-foreground sm:px-6">Loading order…</p>;
  return children;
}
