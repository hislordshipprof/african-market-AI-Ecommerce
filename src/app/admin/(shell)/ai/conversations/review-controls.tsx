"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { labelConversationAction } from "@/lib/admin/ai-oversight-actions";
import { REVIEW_LABELS, REVIEW_LABEL_TEXT, type ConversationKind, type ReviewLabel } from "@/lib/admin/ai-review";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/** J and K move to the next and previous chat in the list, unless the admin is typing. */
export function InboxKeys({ nextHref, prevHref }: { nextHref: string | null; prevHref: string | null }) {
  const router = useRouter();
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      const key = event.key.toLowerCase();
      const href = key === "j" ? nextHref : key === "k" ? prevHref : null;
      if (!href) return;
      event.preventDefault();
      router.push(href, { scroll: false });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nextHref, prevHref, router]);

  // Keep the open chat in view in the list as J and K move through it.
  useEffect(() => {
    document.querySelector("[data-inbox-list] [aria-current='true']")?.scrollIntoView({ block: "nearest" });
  });

  return null;
}

/** One click saves a label, with the note if one was written, then opens the next unlabelled chat. */
export function ReviewButtons({ kind, conversationId, nextUnlabelledHref }: {
  kind: ConversationKind;
  conversationId: string;
  nextUnlabelledHref: string | null;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ReviewLabel | null>(null);
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState<ReviewLabel | null>(null);

  function save(label: ReviewLabel) {
    setSaving(label);
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
      setNote("");
      setSaved(label);
      if (nextUnlabelledHref) router.push(nextUnlabelledHref, { scroll: false });
      else router.refresh();
    });
  }

  return (
    <div className="grid gap-3">
      <label className="grid gap-1 text-sm font-medium text-foreground">
        <span>
          Note <span className="font-normal text-muted-foreground">(optional)</span>
        </span>
        <textarea
          name="note"
          autoComplete="off"
          value={note}
          maxLength={1000}
          rows={2}
          onChange={(event) => setNote(event.target.value)}
          className={`w-full rounded-lg border border-input bg-background px-3 py-2 text-base text-foreground ${FOCUS}`}
        />
      </label>
      <div role="group" aria-label="Label this chat" className="flex flex-wrap gap-2 xl:grid xl:grid-cols-1">
        {REVIEW_LABELS.map((label) => (
          <button
            key={label}
            type="button"
            disabled={pending}
            onClick={() => save(label)}
            className={`min-h-11 rounded-full border border-input px-4 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60 xl:text-left ${FOCUS}`}
          >
            {pending && saving === label ? "Saving…" : REVIEW_LABEL_TEXT[label]}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {saved && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Labelled {REVIEW_LABEL_TEXT[saved]}. Nothing else to label in this list.
        </p>
      )}
    </div>
  );
}
