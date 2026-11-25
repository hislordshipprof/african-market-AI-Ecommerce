"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { replyToThreadAction } from "@/lib/support/store-actions";
import { suggestThreadReply } from "@/lib/copilot/actions";

/** `canSuggest`: the owner on Pro can ask the store assistant for a reply to edit and send (#820); it never sends. */
export function ThreadReply({ threadId, canSuggest = false }: { threadId: string; canSuggest?: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [suggesting, startSuggest] = useTransition();
  const [suggested, setSuggested] = useState<string | null>(null);
  // A suggestion replaces only an empty reply or the last suggestion, never the owner's own words.
  const mayReplace = !draft.trim() || draft === suggested;

  function suggest() {
    startSuggest(async () => {
      let result;
      try {
        result = await suggestThreadReply({ threadId });
      } catch {
        setError("We couldn't get a suggestion. Check your connection and try again.");
        return;
      }
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError(null);
      setDraft(result.text);
      setSuggested(result.text);
    });
  }

  function send(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    startTransition(async () => {
      let result;
      try {
        result = await replyToThreadAction({ threadId, body });
      } catch {
        // Uncaught, the rejection reaches the error boundary and the draft is lost.
        setError("We couldn't send your reply. Check your connection and try again.");
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setDraft("");
      setSuggested(null);
      router.refresh();
    });
  }

  return (
    <form onSubmit={send} className="grid gap-2">
      <label htmlFor="thread-reply" className="text-sm font-medium text-foreground">Reply</label>
      <Textarea
        id="thread-reply"
        value={draft}
        maxLength={1000}
        rows={3}
        onChange={(event) => setDraft(event.target.value)}
      />
      {suggested !== null && draft === suggested && (
        <p className="text-xs text-muted-foreground">Suggested by the store assistant from this thread and the order. Check and edit it before you send.</p>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button type="submit" className="min-h-11 sm:flex-1" disabled={pending || suggesting || !draft.trim()}>
          {pending ? "Sending…" : "Send reply"}
        </Button>
        {canSuggest && (
          <Button type="button" variant="outline" className="min-h-11 sm:flex-1" disabled={pending || suggesting || !mayReplace} onClick={suggest}>
            {suggesting ? "Writing a suggestion…" : suggested ? "Suggest another" : "Suggest a reply"}
          </Button>
        )}
      </div>
    </form>
  );
}
