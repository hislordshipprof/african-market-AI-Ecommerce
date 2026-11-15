"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { GoLiveItems, type GoLiveItemView } from "@/components/go-live/go-live-items";
import { goLiveAction } from "@/lib/store-admin/go-live-actions";

/** A store in setup: the go-live checklist, and the owner's Go live once every item is done (#555). */
export function GoLiveCard({ items, isOwner }: { items: GoLiveItemView[]; isOwner: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const done = items.filter((i) => i.done).length;
  const ready = done === items.length;

  function goLive() {
    setError(null);
    startTransition(async () => {
      const result = await goLiveAction();
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  return (
    <section aria-labelledby="go-live-title" className="mb-6 rounded-xl border border-border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="go-live-title" className="text-base font-semibold text-foreground">Get ready to go live</h2>
        <p className="text-sm text-muted-foreground" data-testid="go-live-progress">{done} of {items.length} done</p>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Shoppers see &ldquo;Opening soon&rdquo; and cannot check out until your store goes live.
      </p>
      <div className="mt-3">
        <GoLiveItems items={items} />
      </div>
      <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center">
        {isOwner ? (
          <Button
            type="button"
            size="lg"
            className="min-h-11 rounded-full px-6"
            disabled={!ready || pending}
            aria-describedby="go-live-hint"
            onClick={goLive}
          >
            {pending ? "Going live…" : "Go live"}
          </Button>
        ) : null}
        <p id="go-live-hint" className="text-sm text-muted-foreground">
          {!isOwner
            ? "The owner goes live once every item is done."
            : ready
              ? "After you go live, place one small order yourself and refund it, to see what shoppers see."
              : "Go live turns on once every item is done."}
        </p>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    </section>
  );
}
