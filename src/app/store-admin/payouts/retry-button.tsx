"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";

/** Reloads the server-rendered payouts after a failed Stripe load. */
export function RetryButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <RotateCw className={`size-4 ${pending ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden />
      {pending ? "Retrying..." : "Retry"}
    </button>
  );
}
