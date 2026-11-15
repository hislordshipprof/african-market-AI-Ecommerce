"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { runDuplicateScan, type ScanState } from "@/lib/admin/catalog-duplicates";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function ScanForm() {
  const router = useRouter();
  const [state, action, scanning] = useActionState<ScanState, FormData>(runDuplicateScan, {});

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state, router]);

  return (
    <form action={action} className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
      <button
        type="submit"
        disabled={scanning}
        className={`inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 ${FOCUS}`}
      >
        {scanning ? "Finding duplicates…" : "Find duplicates"}
      </button>
      <p role="status" className="min-w-0 flex-1 text-sm text-muted-foreground">
        {scanning ? "Checking the catalog. Claude judges the 50 most alike pairs; this can take a minute." : state.message ?? "Claude judges the 50 most alike pairs, within the daily AI spend limit."}
      </p>
    </form>
  );
}
