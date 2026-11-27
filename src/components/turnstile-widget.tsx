"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";

type Turnstile = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

/**
 * Cloudflare Turnstile, managed mode (#872). Inside a form it adds the hidden cf-turnstile-response input;
 * onToken reports the token (null once it expires or fails) for forms that submit their own payload.
 * A token is good for one check, so a new resetOn value (each submit's result) asks for a fresh one.
 */
export function TurnstileWidget({ siteKey, onToken, resetOn, className }: {
  siteKey: string;
  onToken?: (token: string | null) => void;
  resetOn?: unknown;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const report = useRef(onToken);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    report.current = onToken;
  });

  useEffect(() => {
    const api = window.turnstile;
    if (!loaded || !api || !box.current) return;
    const id = api.render(box.current, {
      sitekey: siteKey,
      size: "flexible",
      callback: (token: string) => report.current?.(token),
      "expired-callback": () => report.current?.(null),
      "error-callback": () => report.current?.(null),
    });
    widget.current = id;
    return () => {
      widget.current = null;
      api.remove(id);
      report.current?.(null);
    };
  }, [loaded, siteKey]);

  const lastReset = useRef(resetOn);
  useEffect(() => {
    if (Object.is(lastReset.current, resetOn)) return;
    lastReset.current = resetOn;
    if (!widget.current) return;
    window.turnstile?.reset(widget.current);
    report.current?.(null);
  }, [resetOn]);

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={() => setLoaded(true)}
      />
      <div ref={box} className={className} data-testid="turnstile" />
    </>
  );
}
