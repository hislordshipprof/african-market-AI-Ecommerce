"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { labelConversationAction } from "@/lib/admin/ai-oversight-actions";
import { REVIEW_LABELS, REVIEW_LABEL_TEXT, type ReviewLabel } from "@/lib/admin/ai-review";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function LabelForm({ kind, conversationId }: { kind: "shopper" | "copilot"; conversationId: string }) {
  const router = useRouter();
  const [label, setLabel] = useState<ReviewLabel | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!label) {
      setError("Pick a label.");
      return;
    }
    startTransition(async () => {
      let result;
      try {
        result = await labelConversationAction({ kind, conversationId, label, note });
      } catch {
        setError("That didn't go through. Check your connection and try again.");
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setLabel(null);
      setNote("");
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-foreground">Label</legend>
        <div className="flex flex-wrap gap-2">
          {REVIEW_LABELS.map((value) => (
            <label
              key={value}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-input px-4 text-sm text-foreground has-[:checked]:border-foreground has-[:checked]:bg-secondary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
            >
              <input
                type="radio"
                name="label"
                value={value}
                checked={label === value}
                onChange={() => {
                  setLabel(value);
                  setSaved(false);
                }}
                className="size-4 accent-foreground"
              />
              {REVIEW_LABEL_TEXT[value]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="grid gap-1 text-sm font-medium text-foreground">
        <span>
          Note <span className="font-normal text-muted-foreground">(optional, up to 1000 characters)</span>
        </span>
        <textarea
          name="note"
          value={note}
          maxLength={1000}
          rows={3}
          onChange={(event) => setNote(event.target.value)}
          className={`w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground ${FOCUS}`}
        />
      </label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {saved && !error && <p role="status" className="text-sm text-muted-foreground">Label saved.</p>}
      <button
        type="submit"
        disabled={pending}
        className={`min-h-11 w-fit rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-60 ${FOCUS}`}
      >
        {pending ? "Saving…" : "Save label"}
      </button>
    </form>
  );
}
