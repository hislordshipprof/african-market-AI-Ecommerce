"use client";

import { useActionState, useState } from "react";
import { resolveRefundFailedAction, type ResolveResult } from "@/lib/admin/refund-resolution";

export function ResolveForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState<ResolveResult | null, FormData>(
    resolveRefundFailedAction,
    null,
  );
  const [note, setNote] = useState("");
  const noteValid = note.trim().length >= 1 && note.trim().length <= 500;

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
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
      {state && !state.ok && state.fieldError && !noteValid ? (
        <p className="text-xs text-destructive">{state.fieldError}</p>
      ) : null}
      {state && !state.ok && !state.fieldError ? (
        <p className="text-xs text-destructive">{state.error}</p>
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
