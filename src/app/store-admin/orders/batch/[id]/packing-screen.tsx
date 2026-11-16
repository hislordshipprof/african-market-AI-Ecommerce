"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Check, CheckCircle2, Clock, ImageOff, Package, Truck } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  leaveBatchAction,
  markReadyAction,
  pickBatchLineAction,
  readBatchAction,
  startBatchPackingAction,
} from "@/lib/order/actions";
import type { PickBatchView } from "@/lib/order/batch";
import type { BatchPickLine, BatchSplit } from "@/lib/order/batch-pick-list";
import { STAFF_GENERIC_ERROR } from "@/lib/order/staff-copy";

const STATUS_LABELS: Record<string, string> = {
  ACCEPTED: "Not started",
  PICKING: "Packing",
  SUBSTITUTION_PENDING: "Waiting on customer",
  CAPTURING: "Capturing",
  CANCELLING: "Cancelling",
  READY: "Ready",
  AWAITING_PICKUP: "Ready for pickup",
  COURIER_REQUESTED: "Ready, finding courier",
  COURIER_ASSIGNED: "Ready, courier assigned",
  CANCELLED: "Cancelled",
};

const PACKING = ["ACCEPTED", "PICKING", "SUBSTITUTION_PENDING"];

const time = (value: Date | string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function ToteLetter({ letter, size = "sm" }: { letter: string; size?: "sm" | "lg" }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-muted font-bold tabular-nums text-foreground ${
        size === "lg" ? "size-10 text-lg" : "size-6 text-xs"
      }`}
    >
      {letter}
    </span>
  );
}

/** What happened to one order's share of a combined line. */
function splitOutcome(split: BatchSplit): string | null {
  if (split.status === "pending" || split.status === "picked") return null;
  const found = `found ${split.qtyPicked} of ${split.qty}`;
  if (split.status === "short") return `${found}, waiting for customer`;
  if (split.status === "substituted") return `${found}, swapped`;
  return `${found}, refunded`;
}

function SplitRow({ split }: { split: BatchSplit }) {
  const outcome = splitOutcome(split);
  return (
    <li className="flex items-start gap-2 text-sm">
      <ToteLetter letter={split.letter} />
      <div className="min-w-0 flex-1">
        <p className="text-foreground">
          <span className="font-semibold tabular-nums">×{split.qty}</span>
          <span className="text-muted-foreground"> for #{split.number}</span>
          {split.status === "picked" && <span className="sr-only">, picked</span>}
          {outcome && <span className="text-muted-foreground">, {outcome}</span>}
        </p>
        {split.swap && split.status === "pending" && <p className="text-xs text-muted-foreground">{split.swap}</p>}
      </div>
      {split.status === "picked" && <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
      {split.status === "short" && <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
    </li>
  );
}

function PickRow(props: {
  line: BatchPickLine;
  canPick: boolean;
  disabled: boolean;
  onPickAll: () => void;
  onShort: () => void;
}) {
  const { line } = props;
  return (
    <li
      className="rounded-2xl border border-border bg-card p-3"
      data-testid="batch-line"
    >
      <div className="flex gap-3">
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
          {line.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={line.imageUrl} alt="" className="size-full object-contain" loading="lazy" />
          ) : (
            <ImageOff className="size-5 text-muted-foreground" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-base font-semibold leading-snug text-foreground">
              {line.name} <span className="font-normal text-muted-foreground">{line.label}</span>
            </h3>
            <span className="shrink-0 text-lg font-bold tabular-nums text-foreground" aria-label={`${line.totalQty} in total`}>
              ×{line.totalQty}
            </span>
          </div>
          <ul className="mt-2 space-y-1.5">
            {line.splits.map((split) => (
              <SplitRow key={split.lineId} split={split} />
            ))}
          </ul>
        </div>
      </div>
      {line.open && props.canPick && line.splits.some((split) => split.status === "pending") && (
        <div className="mt-3 flex gap-2">
          <Button variant="outline" className="min-h-12 flex-1 rounded-full" onClick={props.onShort} disabled={props.disabled}>
            Short
          </Button>
          <Button className="min-h-12 flex-[2] rounded-full" onClick={props.onPickAll} disabled={props.disabled}>
            <Check className="mr-1.5 size-4" aria-hidden /> Picked all {line.splits.filter((s) => s.status === "pending").reduce((n, s) => n + s.qty, 0)}
          </Button>
        </div>
      )}
      {!line.open && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4" aria-hidden /> Done
        </p>
      )}
    </li>
  );
}

export function PackingScreen({ initial, storeParam }: { initial: PickBatchView; storeParam: string }) {
  const [batch, setBatch] = useState<PickBatchView | null>(initial);
  const [isPending, startTransition] = useTransition();
  const [shortLine, setShortLine] = useState<BatchPickLine | null>(null);
  const [unitsFound, setUnitsFound] = useState("0");
  const ordersHref = `/store-admin/orders?store=${encodeURIComponent(storeParam)}`;

  const refresh = useCallback(async () => {
    try {
      setBatch(await readBatchAction(initial.batchId));
    } catch {
      // A failed poll keeps the last list; the next one tries again.
    }
  }, [initial.batchId]);

  useEffect(() => {
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, done: string, after?: () => void) {
    startTransition(async () => {
      let result: { ok: boolean; error?: string };
      try {
        result = await action();
      } catch {
        result = { ok: false, error: STAFF_GENERIC_ERROR };
      }
      if (!result.ok) {
        toast.error(result.error ?? STAFF_GENERIC_ERROR);
        return;
      }
      toast.success(done);
      after?.();
      await refresh();
    });
  }

  if (!batch) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-base font-medium text-foreground">This batch has ended</p>
        <p className="mt-1 text-sm text-muted-foreground">Each order is back in the order list with its progress kept.</p>
        <Link href={ordersHref} className={buttonVariants({ className: "mt-6 min-h-12 rounded-full px-6" })}>
          Back to orders
        </Link>
      </main>
    );
  }

  const pickable = batch.totes.filter((tote) => PACKING.includes(tote.status));
  const openLines = batch.zones.reduce((n, zone) => n + zone.lines.filter((line) => line.open).length, 0);
  const allLines = batch.zones.reduce((n, zone) => n + zone.lines.length, 0);
  const pendingShort = shortLine?.splits.filter((split) => split.status === "pending") ?? [];
  const shortTotal = pendingShort.reduce((n, split) => n + split.qty, 0);

  function confirmShort() {
    if (!shortLine) return;
    const found = Number(unitsFound);
    if (!Number.isInteger(found) || found < 0 || found >= shortTotal) {
      toast.error(`Enter a whole number from 0 to ${shortTotal - 1}`);
      return;
    }
    const line = shortLine;
    run(
      () => pickBatchLineAction(batch!.batchId, line.listingVariantId, found),
      "Customers asked to choose a swap or refund",
      () => setShortLine(null),
    );
  }

  return (
    <div className="min-h-dvh bg-background pb-28">
      <header className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link
            href={ordersHref}
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Back to orders"
          >
            <ArrowLeft className="size-5" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-foreground">Pick together</h1>
            <p className="text-xs text-muted-foreground tabular-nums">
              {batch.totes.length} orders · {allLines - openLines} of {allLines} items done
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-5">
        <section aria-label="Bags" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {batch.totes.map((tote) => (
            <div key={tote.orderId} className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-2.5" data-testid="tote">
              <ToteLetter letter={tote.letter} size="lg" />
              <div className="min-w-0">
                <p className="text-sm font-semibold tabular-nums text-foreground">#{tote.number}</p>
                <p className="text-xs text-muted-foreground">{STATUS_LABELS[tote.status] ?? tote.status}</p>
                {tote.fulfillment === "courier" && (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Truck className="size-3" aria-hidden />
                    {tote.readyEstimateAt && PACKING.includes(tote.status) ? `Ready by ${time(tote.readyEstimateAt)}` : "Courier"}
                  </p>
                )}
                {tote.fulfillment === "ship" && (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Package className="size-3" aria-hidden />
                    Shipping
                  </p>
                )}
              </div>
            </div>
          ))}
        </section>
        <p className="mt-2 text-xs text-muted-foreground">
          One bag per letter. Items found go to the oldest order first, so a short lands on the newest.
        </p>

        {batch.zones.map((zone) => (
          <section key={zone.name} className="mt-6" aria-labelledby={`zone-${zone.name}`}>
            <h2 id={`zone-${zone.name}`} className="mb-2 text-sm font-semibold text-muted-foreground">
              {zone.name}
            </h2>
            <ul className="space-y-2">
              {zone.lines.map((line) => (
                <PickRow
                  key={line.listingVariantId}
                  line={line}
                  canPick={batch.packingStarted}
                  disabled={isPending}
                  onPickAll={() => {
                    const total = line.splits.filter((s) => s.status === "pending").reduce((n, s) => n + s.qty, 0);
                    run(() => pickBatchLineAction(batch.batchId, line.listingVariantId, total), `${line.name} picked`);
                  }}
                  onShort={() => {
                    setUnitsFound("0");
                    setShortLine(line);
                  }}
                />
              ))}
            </ul>
          </section>
        ))}

        {batch.totes.some((tote) => tote.canMarkReady) && (
          <section className="mt-6 space-y-2" aria-label="Orders ready to close">
            {batch.totes.filter((tote) => tote.canMarkReady).map((tote) => (
              <Button
                key={tote.orderId}
                className="min-h-12 w-full rounded-full"
                onClick={() => run(() => markReadyAction(tote.orderId), `Order #${tote.number} marked ready`)}
                disabled={isPending}
              >
                <CheckCircle2 className="mr-2 size-4" aria-hidden /> Mark #{tote.number} ready (bag {tote.letter})
              </Button>
            ))}
          </section>
        )}

        <Button
          variant="outline"
          className="mt-6 min-h-12 w-full rounded-full"
          onClick={() => run(() => leaveBatchAction(batch.batchId), pickable.length > 0 ? "Left the batch" : "Batch finished")}
          disabled={isPending}
        >
          {pickable.length > 0 ? "Leave batch" : "Finish batch"}
        </Button>
        {pickable.length > 0 && (
          <p className="mt-2 text-center text-xs text-muted-foreground">Leaving keeps what is picked; each order goes back to the order list.</p>
        )}
      </main>

      {!batch.packingStarted && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-sm">
          <div className="mx-auto max-w-2xl">
            <Button
              className="min-h-12 w-full rounded-full text-base"
              onClick={() => run(() => startBatchPackingAction(batch.batchId), "Packing started")}
              disabled={isPending}
            >
              Start packing
            </Button>
            {batch.totes.some((tote) => tote.fulfillment === "courier") && (
              <p className="mt-1.5 text-center text-xs text-muted-foreground">Books the courier for each courier order.</p>
            )}
          </div>
        </div>
      )}

      <Dialog open={shortLine !== null} onOpenChange={(open) => !open && setShortLine(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Item short</DialogTitle>
            <DialogDescription>
              How many of {shortTotal} × {shortLine?.name} did you find? They fill the oldest order first; each order left short asks its customer to choose a swap or a refund.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="units-found">Units found</Label>
            <Input
              id="units-found"
              type="number"
              inputMode="numeric"
              min={0}
              max={Math.max(0, shortTotal - 1)}
              value={unitsFound}
              onChange={(event) => setUnitsFound(event.target.value)}
              className="mt-1.5 h-12 text-lg"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11 rounded-full" onClick={() => setShortLine(null)}>
              Cancel
            </Button>
            <Button className="min-h-11 rounded-full" onClick={confirmShort} disabled={isPending}>
              Mark short
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
