"use client";

import { useActionState, useEffect, useRef } from "react";
import { addCourierIncidentNoteAction, type IncidentNoteState } from "@/lib/admin/courier-incidents";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Add a note, or resolve with one (#536). The note is required either way, so a resolution says why. */
export function IncidentNoteForm({ orderId, max }: { orderId: string; max: number }) {
  const [state, formAction, pending] = useActionState<IncidentNoteState, FormData>(addCourierIncidentNoteAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (state.saved) formRef.current?.reset();
    if (state.fieldErrors?.body) bodyRef.current?.focus();
  }, [state]);
  const bodyError = state.fieldErrors?.body;

  return (
    <form ref={formRef} action={formAction} className="mt-6 grid gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
      <input type="hidden" name="orderId" value={orderId} />
      <label htmlFor="incident-note" className="text-sm font-medium text-foreground">Note</label>
      <textarea
        ref={bodyRef}
        id="incident-note"
        name="body"
        required
        maxLength={max}
        rows={3}
        defaultValue={state.saved ? "" : state.body}
        aria-invalid={bodyError ? true : undefined}
        aria-describedby={bodyError ? "incident-note-error" : "incident-note-hint"}
        className={`w-full rounded-lg border border-input bg-background px-3 py-2 text-base text-foreground aria-[invalid=true]:border-destructive ${FOCUS}`}
      />
      {bodyError ? (
        <p id="incident-note-error" className="text-sm text-destructive">{bodyError}</p>
      ) : (
        <p id="incident-note-hint" className="text-sm text-muted-foreground">Up to {max.toLocaleString("en-US")} characters. Store staff do not see notes.</p>
      )}
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      {state.fieldErrors?.intent && <p role="alert" className="text-sm text-destructive">{state.fieldErrors.intent}</p>}
      <p aria-live="polite" className="text-sm text-foreground empty:hidden">{state.saved ? "Saved." : ""}</p>
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          name="intent"
          value="resolve"
          disabled={pending}
          className={`inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 ${FOCUS}`}
        >
          Mark resolved
        </button>
        <button
          type="submit"
          name="intent"
          value="note"
          disabled={pending}
          className={`inline-flex min-h-11 items-center rounded-full border border-input px-5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 ${FOCUS}`}
        >
          Add note
        </button>
      </div>
    </form>
  );
}
