"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import "./install-event";

const Prompt = dynamic(() => import("./install-prompt").then(mod => mod.InstallPrompt), { ssr: false });

// Requested a second after load: requested at hydration, the chunk raced the hero's paint and Lighthouse
// then counted it toward the LCP (#563). The prompt never shows sooner than that anyway.
const AFTER_LOAD_MS = 1000;

export function InstallPrompt({ storeName }: { storeName: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let timer = 0;
    const afterLoad = () => { timer = window.setTimeout(() => setReady(true), AFTER_LOAD_MS); };
    if (document.readyState === "complete") afterLoad();
    else window.addEventListener("load", afterLoad, { once: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("load", afterLoad);
    };
  }, []);
  return ready ? <Prompt storeName={storeName} /> : null;
}
