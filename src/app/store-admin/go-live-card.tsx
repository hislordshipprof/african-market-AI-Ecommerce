"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GoLiveItems, type GoLiveItemView } from "@/components/go-live/go-live-items";
import { goLiveAction } from "@/lib/store-admin/go-live-actions";
import { displayAddress } from "@/lib/directory/links";
import { directoryNote, testOrderHint } from "./go-live-hint";

/** A store in setup: the go-live checklist, and the owner's Go live once every item is done (#555). Going live asks first (#784). */
export function GoLiveCard({
  items,
  isOwner,
  minimumOrderCents,
  located,
  onLive,
}: {
  items: GoLiveItemView[];
  isOwner: boolean;
  minimumOrderCents: number;
  /** The store has a map point; without one the directory hides it (#786). */
  located: boolean;
  onLive: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = items.filter((i) => i.done).length;
  const ready = done === items.length;

  function goLive() {
    setError(null);
    startTransition(async () => {
      const result = await goLiveAction();
      setConfirming(false);
      if (result.ok) {
        onLive();
        router.refresh();
      } else setError(result.error);
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
            onClick={() => setConfirming(true)}
          >
            Go live
          </Button>
        ) : null}
        <p id="go-live-hint" className="text-sm text-muted-foreground">
          {!isOwner
            ? "The owner goes live once every item is done."
            : ready
              ? `After you go live: ${testOrderHint(minimumOrderCents)}`
              : "Go live turns on once every item is done."}
        </p>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

      <Dialog open={confirming} onOpenChange={(open) => { if (!pending) setConfirming(open); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Go live now?</DialogTitle>
            <DialogDescription>
              Shoppers can order and pay from now on. {directoryNote(located)} You can unlist it on the Directory
              listing page.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11 rounded-full" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" className="min-h-11 rounded-full px-6" onClick={goLive} disabled={pending}>
              {pending ? "Going live…" : "Go live now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Shown once the owner's Go live lands (#784): the store's address, its directory listing and the test order. */
export function LiveNotice({
  storeAddress,
  storeParam,
  minimumOrderCents,
  located,
}: {
  storeAddress: string | null;
  storeParam: string;
  minimumOrderCents: number;
  located: boolean;
}) {
  return (
    <section role="status" aria-labelledby="live-title" className="mb-6 flex items-start gap-3 rounded-xl border border-primary/40 bg-primary/5 p-4 sm:p-6">
      <PartyPopper className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 text-sm text-foreground">
        <h2 id="live-title" className="text-base font-semibold">You&apos;re live</h2>
        {storeAddress && (
          <p className="mt-1">
            Shoppers can order now at{" "}
            <a href={storeAddress} target="_blank" rel="noreferrer" className="break-all font-medium text-primary underline underline-offset-4">
              {displayAddress(storeAddress)}
            </a>
          </p>
        )}
        <p className="mt-1">
          {directoryNote(located)} To unlist it, open{" "}
          <Link href={`/store-admin/directory?store=${storeParam}`} className="font-medium text-primary underline underline-offset-4">
            Directory listing
          </Link>
          .
        </p>
        <p className="mt-1 text-muted-foreground">{testOrderHint(minimumOrderCents)}</p>
      </div>
    </section>
  );
}
