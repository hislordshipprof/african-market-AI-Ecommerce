"use client";

import { useCallback, useState } from "react";
import { usePathname } from "next/navigation";
import { launcherVisible } from "@/lib/assistant/ui/launcher-gate";
import { assistantHiddenForStore, hideAssistantForStore } from "@/lib/assistant/ui/session-hide";
import { useCart } from "../cart-provider";
import styles from "./assistant.module.css";

export function AssistantLauncher({
  storeId,
  storeStatus,
  accountId,
}: {
  storeId: string;
  storeStatus: string;
  accountId: string | null;
}) {
  const pathname = usePathname() || "/";
  const { loading, attention, cartId, lines, reportCartFailure } = useCart();
  const [hidden, setHidden] = useState(() => assistantHiddenForStore(storeId));
  const hideForSession = useCallback(() => {
    hideAssistantForStore(storeId);
    setHidden(true);
  }, [storeId]);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [Sheet, setSheet] = useState<typeof import("./assistant-sheet").AssistantSheet | null>(null);

  const visible = launcherVisible({
    flag: true,
    storeStatus,
    pathname,
    sessionHidden: hidden,
  });

  function preload() {
    if (!visible) return;
    void import("./assistant-sheet").catch(() => {});
  }

  function openSheet() {
    void import("./assistant-sheet")
      .then((mod) => {
        setSheet(() => mod.AssistantSheet);
        setFailed(false);
        setOpen(true);
      })
      .catch(() => setFailed(true));
  }

  if (!visible && !open) {
    return failed ? <ChunkFailure onRetry={openSheet} /> : null;
  }

  return (
    <>
      {visible ? (
        <button
          type="button"
          className={`${styles.launcher} ${pathname === "/cart" ? styles.onCart : ""}`}
          data-testid="assistant-launcher"
          data-store-id={storeId}
          onMouseEnter={preload}
          onFocus={preload}
          onClick={openSheet}
        >
          Shop with help
        </button>
      ) : null}
      {failed ? <ChunkFailure onRetry={openSheet} /> : null}
      {Sheet ? (
        <Sheet
          open={open}
          onClose={() => setOpen(false)}
          storeId={storeId}
          accountId={accountId}
          cartId={cartId}
          loading={loading}
          attention={attention}
          lines={lines}
          onCartFailure={reportCartFailure}
          onTerminal={hideForSession}
        />
      ) : null}
    </>
  );
}

function ChunkFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={styles.notice} role="status">
      <p>The helper couldn&apos;t load.</p>
      <a href="/search">Search the shelves</a>
      <button type="button" className={styles.ghost} onClick={onRetry}>Retry</button>
    </div>
  );
}
