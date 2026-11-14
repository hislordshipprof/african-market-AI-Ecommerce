"use client";

import { useActionState, useState } from "react";
import { resolveRefundFailedAction, type ResolveResult } from "@/lib/admin/refund-resolution";

export function ResolveForm({
  orderId,
  owedCents,
  capturedCents,
}: {
  orderId: string;
  owedCents: number;
  capturedCents: number;
}) {
  const [state, action, pending] = useActionState<ResolveResult | null, FormData>(
    resolveRefundFailedAction,
    null,
  );
  const [note, setNote] = useState("");
  const [repaidDollars, setRepaidDollars] = useState((owedCents / 100).toFixed(2));
  const capturedDollars = (capturedCents / 100).toFixed(2);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="displayedOwedCents" value={String(owedCents)} />
      <label htmlFor={`repaid-${orderId}`} className="text-sm text-foreground">
        Amount repaid
      </label>
      <input
        id={`repaid-${orderId}`}
        name="repaidDollars"
        inputMode="decimal"
        autoComplete="off"
        required
        aria-describedby={`repaid-hint-${orderId}`}
        value={repaidDollars}
        onChange={(event) => setRepaidDollars(event.target.value)}
        className="w-full rounded-md border border-input px-3 py-2 text-sm text-foreground tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <p id={`repaid-hint-${orderId}`} className="text-xs text-muted-foreground">
        Dollars you paid the customer, from $0.01 to ${capturedDollars}.
      </p>
      <label htmlFor={`note-${orderId}`} className="text-sm text-foreground">
        Resolution note
      </label>
      <input
        id={`note-${orderId}`}
        name="note"
        required
        maxLength={500}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="w-full rounded-md border border-input px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {state && !state.ok && state.fieldError ? (
        <p className="text-xs text-destructive">{state.fieldError}</p>
      ) : null}
      {state && !state.ok && !state.fieldError ? (
        <p className="text-xs text-destructive">{state.error}</p>
      ) : null}
      {state && state.ok && state.message ? (
        <p className="text-sm text-foreground">{state.message}</p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="w-fit rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        Mark resolved
      </button>
    </form>
  );
}
