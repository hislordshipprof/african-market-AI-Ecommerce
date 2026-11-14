"use client";

import { useEffect, useRef, useState } from "react";
import { Share, SquarePlus, X } from "lucide-react";
import { isIos, isStandalone } from "@/lib/push/client";

const VISITS = "pwa:visits";
const COUNTED = "pwa:visit-counted";
const ORDERED = "pwa:ordered";
const DISMISSED = "pwa:install-dismissed";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the prompt simply shows again next time.
  }
}

/** Called by the tracking page: a first order makes the store worth installing. */
export function rememberOrder(): void {
  write(ORDERED, "1");
}

/** Counts one visit per browser session. */
function countVisit(): number {
  let visits = Number(read(VISITS) ?? "0") || 0;
  try {
    if (!sessionStorage.getItem(COUNTED)) {
      sessionStorage.setItem(COUNTED, "1");
      visits += 1;
      write(VISITS, String(visits));
    }
  } catch {
    // No session storage: count nothing.
  }
  return visits;
}

/**
 * "Add {store} to your Home Screen", after a second visit or a first order. Android and desktop
 * Chrome use the browser's own install prompt; iOS has none, so it gets a one-time how-to.
 * Closing it in any way is remembered.
 */
export function InstallPrompt({ storeName }: { storeName: string }) {
  const [mode, setMode] = useState<"android" | "ios" | null>(null);
  const deferred = useRef<InstallEvent | null>(null);

  useEffect(() => {
    if (isStandalone() || read(DISMISSED)) return;
    const visits = countVisit();
    const eligible = () => visits >= 2 || read(ORDERED) === "1";

    if (isIos()) {
      if (!eligible()) return;
      // One time only: a later visit never shows it again, closed or not.
      write(DISMISSED, "1");
      const timer = window.setTimeout(() => setMode("ios"), 1500);
      return () => window.clearTimeout(timer);
    }

    function onPrompt(event: Event) {
      event.preventDefault();
      deferred.current = event as InstallEvent;
      if (eligible() && !read(DISMISSED)) setMode("android");
    }
    function onInstalled() {
      write(DISMISSED, "1");
      setMode(null);
    }
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!mode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  function close() {
    write(DISMISSED, "1");
    setMode(null);
  }

  async function install() {
    const event = deferred.current;
    close();
    if (!event) return;
    deferred.current = null;
    await event.prompt().catch(() => undefined);
  }

  if (!mode) return null;

  return (
    <section className="sf-install-sheet" role="dialog" aria-modal="false" aria-labelledby="sf-install-title">
      <button type="button" className="sf-install-close" onClick={close} aria-label="Close">
        <X size={20} aria-hidden />
      </button>
      <div className="sf-install-head">
        {/* eslint-disable-next-line @next/next/no-img-element -- a same-origin PNG of the store icon, already the right size */}
        <img src="/pwa-icons/icon-192.png" alt="" width={48} height={48} />
        <div>
          <h2 id="sf-install-title">Add {storeName} to your Home Screen</h2>
          <p>Open the store in one tap and get order updates on this device.</p>
        </div>
      </div>
      {mode === "ios" ? (
        <>
          <ol className="sf-install-steps">
            <li>
              <span className="sf-install-step-icon"><Share size={18} aria-hidden /></span>
              Tap <strong>Share</strong> in Safari&rsquo;s toolbar.
            </li>
            <li>
              <span className="sf-install-step-icon"><SquarePlus size={18} aria-hidden /></span>
              Choose <strong>Add to Home Screen</strong>.
            </li>
          </ol>
          <div className="sf-install-actions">
            <button type="button" className="sf-button" onClick={close}>Got it</button>
          </div>
        </>
      ) : (
        <div className="sf-install-actions">
          <button type="button" className="sf-button" onClick={install}>Install</button>
          <button type="button" className="sf-install-later" onClick={close}>Not now</button>
        </div>
      )}
    </section>
  );
}
