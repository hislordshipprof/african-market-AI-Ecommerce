"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Minus, Plus, Undo2, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/format";
import { markNoShowAction, storeRefundAction } from "@/lib/order/actions";
import { ActionError } from "./action-error";

export type RefundableLine = { id: string; name: string; variant: string; unitPriceCents: number; refundableQty: number };

type Props = {
  orderId: string;
  /** A pickup the customer has not collected yet can be marked as not collected. */
  canMarkNoShow: boolean;
  /** The store still holds the goods, so the whole order is cancelled rather than refunded. */
  wholeCancels: boolean;
  lines: RefundableLine[];
  /** After a refund; without it the page reloads its data and a toast confirms. */
  onDone?: (message: string) => void;
};

/** The owner's refund after capture (#798): items and quantities or the whole order, with a reason. */
export function RefundOrder({ orderId, canMarkNoShow, wholeCancels, lines, onDone }: Props) {
  const [open, setOpen] = useState<"refund" | "no_show" | null>(null);
  const [whole, setWhole] = useState(false);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [submissionId, setSubmissionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const done = onDone ?? ((message: string) => {
    toast.success(message);
    router.refresh();
  });

  const refundable = lines.filter((line) => line.refundableQty > 0);
  const picks = Object.entries(qty).filter(([, n]) => n > 0).map(([lineId, n]) => ({ lineId, qty: n }));
  const goodsCents = refundable.reduce((sum, line) => sum + (qty[line.id] ?? 0) * line.unitPriceCents, 0);

  function show(kind: "refund" | "no_show") {
    setWhole(refundable.length === 0);
    setQty({});
    setReason("");
    setError(null);
    setSubmissionId(crypto.randomUUID());
    setOpen(kind);
  }

  function step(line: RefundableLine, by: number) {
    setQty((current) => ({ ...current, [line.id]: Math.min(line.refundableQty, Math.max(0, (current[line.id] ?? 0) + by)) }));
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = open === "no_show"
        ? await markNoShowAction(orderId, reason || null)
        : await storeRefundAction(orderId, { picks: whole ? "whole_order" : picks, reason, submissionId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(null);
      if ("cancelled" in result && result.cancelled) done("Order cancelled. The customer is refunded in full.");
      else if ("amountCents" in result) done(`${money(result.amountCents)} refunded${result.pending ? ", confirming with the bank" : ""}.`);
    });
  }

  const ready = open === "no_show" || (reason.trim().length > 0 && (whole || picks.length > 0));

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11 flex-1 rounded-full" onClick={() => show("refund")}>
          <Undo2 className="mr-2 size-4" aria-hidden /> Refund
        </Button>
        {canMarkNoShow && (
          <Button variant="outline" className="min-h-11 flex-1 rounded-full" onClick={() => show("no_show")}>
            <UserX className="mr-2 size-4" aria-hidden /> Not collected
          </Button>
        )}
      </div>

      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{open === "no_show" ? "Customer did not collect" : "Refund"}</DialogTitle>
            <DialogDescription>
              {open === "no_show"
                ? "The order is cancelled and the customer is refunded in full. Put the items back on the shelf."
                : "The money goes back to the customer's card. The customer is told."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {open === "refund" && (
              <>
                <div role="group" aria-label="What to refund" className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={whole ? "outline" : "default"}
                    aria-pressed={!whole}
                    disabled={refundable.length === 0}
                    className="min-h-11 rounded-full"
                    onClick={() => setWhole(false)}
                  >
                    Items
                  </Button>
                  <Button
                    type="button"
                    variant={whole ? "default" : "outline"}
                    aria-pressed={whole}
                    className="min-h-11 rounded-full"
                    onClick={() => setWhole(true)}
                  >
                    Whole order
                  </Button>
                </div>
                {whole ? (
                  <p className="text-sm text-muted-foreground">
                    {wholeCancels
                      ? "Everything left on the order is refunded and the order is cancelled."
                      : "Everything left on the order is refunded."}
                  </p>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {refundable.map((line) => (
                      <li key={line.id} className="flex items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{line.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {line.variant} · {money(line.unitPriceCents)} each · {line.refundableQty} left to refund
                          </p>
                        </div>
                        <Button type="button" variant="outline" size="icon" className="size-11 rounded-full" aria-label={`One less ${line.name}`} onClick={() => step(line, -1)} disabled={!qty[line.id]}>
                          <Minus className="size-4" aria-hidden />
                        </Button>
                        <span className="w-6 text-center tabular-nums" aria-live="polite" aria-label={`${line.name} to refund`}>{qty[line.id] ?? 0}</span>
                        <Button type="button" variant="outline" size="icon" className="size-11 rounded-full" aria-label={`One more ${line.name}`} onClick={() => step(line, 1)} disabled={(qty[line.id] ?? 0) >= line.refundableQty}>
                          <Plus className="size-4" aria-hidden />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {!whole && goodsCents > 0 && (
                  <p className="text-sm text-muted-foreground">
                    Items {money(goodsCents)}, plus their share of the service fee and tax.
                  </p>
                )}
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="refund-reason">{open === "no_show" ? "Note (optional)" : "Reason"}</Label>
              <Textarea id="refund-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <ActionError message={error} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)} className="min-h-11 rounded-full">
              Keep order
            </Button>
            <Button variant="destructive" onClick={submit} disabled={isPending || !ready} className="min-h-12 rounded-full">
              {open === "no_show" ? "Cancel and refund" : whole && wholeCancels ? "Cancel and refund" : "Refund"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
