"use client";

import { useState } from "react";
import { Check, CircleAlert, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export const AUTH_INPUT = "h-12 text-base md:text-base";
export const AUTH_CODE_INPUT = "h-12 text-center text-lg tracking-[0.3em] md:text-lg";
export const AUTH_SUBMIT = "mt-2 h-12 w-full rounded-full text-base font-semibold";
export const AUTH_QUIET_ACTION =
  "flex h-11 w-full items-center justify-center rounded-full text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";

/** Authenticator apps show codes as "123 456", and a paste should still work. */
export function totpDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

export function totpErrorMessage(error: { code?: string; message?: string }, fallback: string): string {
  if (error.code === "INVALID_CODE") {
    return "That code didn't match. Codes change every 30 seconds, so enter the newest one.";
  }
  if (error.code === "INVALID_TWO_FACTOR_COOKIE") {
    return "This sign-in timed out. Go back and sign in again.";
  }
  return error.message ?? fallback;
}

export function AuthError({ id, children }: { id: string; children: string }) {
  return (
    <div
      id={id}
      role="alert"
      className="mb-4 flex gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {children}
    </div>
  );
}

export function CopyRow({ label, display, value }: { label: string; display: string; value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <code className="block truncate text-xs">{display}</code>
      </div>
      <Button
        type="button"
        variant="ghost"
        onClick={copy}
        aria-label={`Copy ${label.toLowerCase()}`}
        className="size-11 shrink-0 rounded-full"
      >
        {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied" && `${label} copied`}
        {state === "failed" && `Couldn't copy the ${label.toLowerCase()}. Select it and copy by hand.`}
      </span>
    </div>
  );
}
