"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Layers } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { startBatchAction } from "@/lib/order/actions";
import { MAX_BATCH_ORDERS, MIN_BATCH_ORDERS } from "@/lib/order/batch-pick-list";
import { STAFF_GENERIC_ERROR } from "@/lib/order/staff-copy";
import { ActionError } from "./action-error";

type Row = { id: string; number: number; status: string; pickBatchId: string | null; lines: unknown[] };

const PACKING = ["ACCEPTED", "PICKING", "SUBSTITUTION_PENDING"];

export function packingHref(batchId: string, storeParam: string): string {
  return `/store-admin/orders/batch/${encodeURIComponent(batchId)}?store=${encodeURIComponent(storeParam)}`;
}

/**
 * Batch picking (#564): choose 2-4 Accepted orders to pick in one walk, or go back to a batch
 * already open. Shown only when there is something to batch or a batch to return to.
 */
export function BatchPicking({ orders, storeParam }: { orders: Row[]; storeParam: string }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const batchable = orders.filter((order) => order.status === "ACCEPTED" && order.pickBatchId === null);
  const open = new Map<string, number[]>();
  for (const order of orders) {
    if (!order.pickBatchId || !PACKING.includes(order.status)) continue;
    open.set(order.pickBatchId, [...(open.get(order.pickBatchId) ?? []), order.number]);
  }
  const selected = chosen.filter((id) => batchable.some((order) => order.id === id));
  if (batchable.length < MIN_BATCH_ORDERS && open.size === 0) return null;

  function toggle(id: string) {
    setChosen((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  function start() {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof startBatchAction>>;
      try {
        result = await startBatchAction(selected);
      } catch {
        result = { ok: false, error: STAFF_GENERIC_ERROR };
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(packingHref(result.batchId, storeParam));
    });
  }

  const count = selected.length;
  const ready = count >= MIN_BATCH_ORDERS && count <= MAX_BATCH_ORDERS;

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="size-4 text-muted-foreground" aria-hidden /> Pick orders together
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {open.size > 0 && (
          <ul className="space-y-2" aria-label="Open batches">
            {[...open.entries()].map(([batchId, numbers]) => (
              <li key={batchId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-sm text-foreground tabular-nums">
                  Batch of {numbers.map((n) => `#${n}`).join(", ")}
                </span>
                <Link href={packingHref(batchId, storeParam)} className={buttonVariants({ variant: "outline", className: "min-h-11 rounded-full px-4" })}>
                  Open packing screen
                </Link>
              </li>
            ))}
          </ul>
        )}
        {batchable.length >= MIN_BATCH_ORDERS && (
          <fieldset>
            <legend className="mb-2 text-sm text-muted-foreground">
              Choose {MIN_BATCH_ORDERS} to {MAX_BATCH_ORDERS} accepted orders. Shared items are picked once and split into a bag per order.
            </legend>
            <div className="flex flex-wrap gap-2">
              {batchable.map((order) => {
                const checked = selected.includes(order.id);
                return (
                  <label
                    key={order.id}
                    className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm tabular-nums ${
                      checked ? "border-foreground bg-muted font-semibold text-foreground" : "border-border text-foreground"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-primary)]"
                      checked={checked}
                      onChange={() => toggle(order.id)}
                      disabled={!checked && count >= MAX_BATCH_ORDERS}
                    />
                    #{order.number} · {order.lines.length} item{order.lines.length === 1 ? "" : "s"}
                  </label>
                );
              })}
            </div>
            <Button className="mt-3 min-h-11 w-full rounded-full sm:w-auto sm:px-6" onClick={start} disabled={!ready || isPending}>
              {ready ? `Pick ${count} orders together` : "Pick together"}
            </Button>
            <ActionError message={error} className="mt-2" />
          </fieldset>
        )}
      </CardContent>
    </Card>
  );
}
