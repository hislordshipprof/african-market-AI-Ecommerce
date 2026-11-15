"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { replyAsPlatformAction, resolveThreadAction } from "@/lib/support/platform-actions";

export function PlatformThreadActions({ threadId, seenAt }: { threadId: string; seenAt: string | null }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>, clearDraft: boolean) {
    startTransition(async () => {
      let result;
      try {
        result = await action();
      } catch {
        setError("That didn't go through. Check your connection and try again.");
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      if (clearDraft) setDraft("");
      router.refresh();
    });
  }

  function send(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    run(() => replyAsPlatformAction({ threadId, body }), true);
  }

  return (
    <form onSubmit={send} className="flex flex-col gap-2">
      <label htmlFor={`reply-${threadId}`} className="text-sm text-foreground">
        Reply as the platform team
      </label>
      <textarea
        id={`reply-${threadId}`}
        value={draft}
        maxLength={1000}
        rows={3}
        onChange={(event) => setDraft(event.target.value)}
        className="w-full rounded-md border border-input px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || !draft.trim()}
          className="w-fit rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send reply"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => resolveThreadAction({ threadId, seenAt }), false)}
          className="w-fit rounded-full border border-input px-4 py-2 text-sm font-medium text-foreground disabled:opacity-50"
        >
          Mark resolved
        </button>
      </div>
    </form>
  );
}
