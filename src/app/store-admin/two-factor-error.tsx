"use client";

import Link from "next/link";
import { toast } from "sonner";

export const SET_UP_2FA = "Set up 2FA";

/** The link a gated action returns without 2FA (#840): setup, then back to this page. */
export function TwoFactorSetupLink({ href }: { href: string }) {
  return (
    <Link href={href} className="font-semibold whitespace-nowrap text-primary underline underline-offset-4">
      {SET_UP_2FA}
    </Link>
  );
}

/** The setup link on a failed action's result, if 2FA is what it needs. */
export function setupHrefOf(result: object): string | undefined {
  return "setupHref" in result && typeof result.setupHref === "string" ? result.setupHref : undefined;
}

/** A failed action's toast; with a setup link when 2FA is what it needs. */
export function toastActionError(result: { error?: string; setupHref?: string }, fallback = "Something went wrong. Try again.") {
  const { setupHref } = result;
  toast.error(result.error ?? fallback, setupHref
    ? { action: { label: SET_UP_2FA, onClick: () => window.location.assign(setupHref) }, duration: 15_000 }
    : undefined);
}
