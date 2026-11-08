"use client";

import { useEffect, useState, useSyncExternalStore, type ComponentProps } from "react";
import { ArrowLeft, Check, CircleAlert, Copy, Eye, EyeOff } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const AUTH_INPUT = "h-12 text-base md:text-base";
export const AUTH_CODE_INPUT = "h-12 text-center text-lg tracking-[0.3em] md:text-lg";
// The stock 50% disabled fill drops the pending label below AA.
export const AUTH_SUBMIT =
  "mt-2 h-12 w-full cursor-pointer rounded-full text-base font-semibold disabled:opacity-80";
// Above the heading on purpose: down by the submit button, a second tap on the button
// would land on this link after the step changes.
export const AUTH_BACK =
  "-ml-2 mb-1 inline-flex h-11 w-fit items-center gap-1.5 rounded-full px-2 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";
export const AUTH_CODE_HINT = "Enter all 6 digits";

/** Authenticator apps show codes as "123 456", and a paste should still work. */
export function totpDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

export const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

// The name authenticator apps show for this account: the issuer in src/lib/auth.ts.
export const AUTHENTICATOR_ENTRY = "African Markets Platform";

export const TOTP_ERRORS: Record<string, string> = {
  INVALID_CODE: "That code didn't match. Codes change every 30 seconds, so enter the newest one.",
  INVALID_TWO_FACTOR_COOKIE: "This sign-in timed out. Go back and sign in again.",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "Too many wrong codes. Go back and sign in again.",
  ACCOUNT_TEMPORARILY_LOCKED: "Too many wrong codes, so this account is locked for now. Try again in 15 minutes.",
};

const subscribeToNothing = () => () => {};

/**
 * Before hydration a submit would be the browser's own, which reloads the page and wipes
 * what was typed. Keeping the submit button disabled until then blocks that, Enter included.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribeToNothing, () => true, () => false);
}

/** Says what to do next, in place of the server's raw wording. */
export function authErrorMessage(
  error: { status?: number; code?: string; message?: string },
  byCode: Record<string, string>,
  fallback: string,
): string {
  const known = error.code ? byCode[error.code] : undefined;
  if (known) return known;
  if (error.status === 429) return "Too many attempts. Wait a few minutes and try again.";
  if (error.status !== undefined && error.status >= 500) {
    return "Something went wrong on our side. Try again in a moment.";
  }
  return error.message ?? fallback;
}

/**
 * Sign-in fields are uncontrolled, and read here on submit. The form paints well before
 * hydration on a slow phone, and React would wipe what was typed into a controlled field.
 */
export function fieldValue(form: HTMLFormElement, id: string): string {
  return (form.elements.namedItem(id) as HTMLInputElement).value;
}

/** The submit button is disabled while pending, so a failure would otherwise drop focus to the page. */
export function focusField(id: string) {
  document.getElementById(id)?.focus();
}

export function BackArrow() {
  return <ArrowLeft aria-hidden="true" className="size-4" />;
}

export function AuthError({ id, children }: { id: string; children: string }) {
  return (
    <div id={id} role="alert" className="flex gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {children}
    </div>
  );
}

export function PasswordInput({ className, ...props }: ComponentProps<typeof Input>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={shown ? "text" : "password"} className={cn(AUTH_INPUT, "pr-12", className)} />
      <button
        type="button"
        onClick={() => setShown((value) => !value)}
        aria-label={shown ? "Hide characters" : "Show characters"}
        className="absolute inset-y-0 right-0 flex w-12 cursor-pointer items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground"
      >
        {shown ? <EyeOff aria-hidden="true" className="size-5" /> : <Eye aria-hidden="true" className="size-5" />}
      </button>
    </div>
  );
}

export function CopyRow({
  label,
  display,
  value,
  wrap = false,
}: {
  label: string;
  display: string;
  value: string;
  /** Show the whole value, for something a person has to read and type. */
  wrap?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state !== "copied") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="rounded-lg bg-muted py-1 pr-1 pl-3">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <code className={cn("block", wrap ? "text-sm break-words" : "truncate text-xs")}>{display}</code>
        </div>
        <Button
          type="button"
          variant="ghost"
          onClick={copy}
          aria-label={`Copy ${label.toLowerCase()}`}
          className="size-11 shrink-0 cursor-pointer rounded-full"
        >
          {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
      <p role="status" className={cn("pr-2 text-xs", state === "failed" ? "pb-1 text-destructive" : "sr-only")}>
        {state === "copied" && `${label} copied`}
        {state === "failed" && `Couldn't copy the ${label.toLowerCase()}. Select it and copy by hand.`}
      </p>
    </div>
  );
}
