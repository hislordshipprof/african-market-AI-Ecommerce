"use client";

import { useEffect, useState, useTransition } from "react";
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
import { markNoShowAction, storeRefundAction, storeRefundPreviewAction } from "@/lib/order/actions";
import type { StoreRefundPreview } from "@/lib/order/store-refund";
import { ActionError } from "./action-error";
import { setupHrefOf } from "../two-factor-error";

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
  const [error, setError] = useState<{ message: string; setupHref?: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const done = onDone ?? ((message: string) => {
    toast.success(message);
    router.refresh();
  });

  const refundable = lines.filter((line) => line.refundableQty > 0);
  const picks = Object.entries(qty).filter(([, n]) => n > 0).map(([lineId, n]) => ({ lineId, qty: n }));
  const picksKey = whole ? "whole_order" : JSON.stringify(picks);
  // The amount comes from the server's refund calculation, so the dialog shows what the refund records (#806).
  const [preview, setPreview] = useState<{ key: string; result: StoreRefundPreview } | null>(null);
  const shown = open === "refund" && preview?.key === picksKey ? preview.result : null;

  useEffect(() => {
    if (open !== "refund" || picksKey === "[]") return;
    let live = true;
    const timer = setTimeout(() => {
      storeRefundPreviewAction(orderId, whole ? "whole_order" : JSON.parse(picksKey))
        .then((result) => live && setPreview({ key: picksKey, result }))
        .catch(() => live && setPreview({ key: picksKey, result: { ok: false, error: "The amount could not be worked out. Try again." } }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, orderId, whole, picksKey]);

  function show(kind: "refund" | "no_show") {
    setWhole(refundable.length === 0);
    setQty({});
    setReason("");
    setError(null);
    setSubmissionId(crypto.randomUUID());
    setPreview(null);
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
        setError({ message: result.error, setupHref: setupHrefOf(result) });
        return;
      }
      setOpen(null);
      if ("cancelled" in result && result.cancelled) done("Order cancelled. The customer is refunded in full.");
      else if ("amountCents" in result) done(`${money(result.amountCents)} refunded${result.pending ? ", confirming with the bank" : ""}.`);
    });
  }

  const ready = open === "no_show" || (reason.trim().length > 0 && (whole || picks.length > 0) && shown?.ok === true);

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
                {(whole || picks.length > 0) && <RefundAmount preview={shown} />}
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="refund-reason">{open === "no_show" ? "Note (optional)" : "Reason"}</Label>
              <Textarea id="refund-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <ActionError message={error?.message} setupHref={error?.setupHref} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)} className="min-h-11 rounded-full">
              Keep order
            </Button>
            <Button variant="destructive" onClick={submit} disabled={isPending || !ready} className="min-h-12 rounded-full">
              {open === "no_show" ? "Cancel and refund" : `${whole && wholeCancels ? "Cancel and refund" : "Refund"}${shown?.ok ? ` ${money(shown.amountCents)}` : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** What the customer gets back, line by line, before the owner confirms (#806). */
function RefundAmount({ preview }: { preview: StoreRefundPreview | null }) {
  if (!preview) return <p className="text-sm text-muted-foreground" role="status">Working out the amount…</p>;
  if (!preview.ok) return <ActionError message={preview.error} setupHref={setupHrefOf(preview)} />;
  return (
    <dl className="space-y-1 rounded-lg border border-border px-3 py-2 text-sm" aria-live="polite" data-testid="refund-amount">
      {!preview.whole && (
        <>
          <Row label="Items" cents={preview.itemsCents} />
          {preview.couponShareCents > 0 && <Row label="Less their coupon discount" cents={-preview.couponShareCents} />}
          {preview.serviceFeeCents > 0 && <Row label="Their service fee share" cents={preview.serviceFeeCents} />}
          {preview.taxCents > 0 && <Row label="Their tax" cents={preview.taxCents} />}
        </>
      )}
      <div className="flex justify-between gap-3 font-semibold">
        <dt>The customer gets back</dt>
        <dd className="tabular-nums">{money(preview.amountCents)}</dd>
      </div>
    </dl>
  );
}

function Row({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex justify-between gap-3 text-muted-foreground">
      <dt>{label}</dt>
      <dd className="tabular-nums">{cents < 0 ? `−${money(-cents)}` : money(cents)}</dd>
    </div>
  );
}
