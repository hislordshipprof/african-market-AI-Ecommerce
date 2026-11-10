"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { replyToThreadAction } from "@/lib/support/store-actions";

export function ThreadReply({ threadId }: { threadId: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function send(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    startTransition(async () => {
      const result = await replyToThreadAction({ threadId, body });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setDraft("");
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
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="min-h-11" disabled={pending || !draft.trim()}>
        {pending ? "Sending…" : "Send reply"}
      </Button>
    </form>
  );
}
