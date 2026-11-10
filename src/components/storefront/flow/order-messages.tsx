"use client";

import { useEffect, useState, useTransition } from "react";
import { sendOrderMessageAction } from "@/lib/support/customer-actions";
import type { ThreadMessage } from "@/lib/support/thread";
import { Button } from "../primitives";
import { FlowCard } from "./common";

const POLL_MS = 10_000;

const time = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(iso));

/** The order's support thread on the tracking page. Polls the cached route every 10 s (ADR-0016). */
export function OrderMessages({
  token,
  storeName,
  initialMessages,
}: {
  token: string;
  storeName: string;
  initialMessages: ThreadMessage[];
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function refresh() {
    const response = await fetch(`/api/order-messages/${encodeURIComponent(token)}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as { messages: ThreadMessage[] };
    setMessages(data.messages);
  }

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function send(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    startTransition(async () => {
      const result = await sendOrderMessageAction({ token, body });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setDraft("");
      await refresh().catch(() => undefined);
    });
  }

  return (
    <FlowCard title="Message the store">
      {messages.length === 0 ? (
        <p>Questions about this order? {storeName} will reply here.</p>
      ) : (
        <ol aria-label="Messages" style={{ listStyle: "none", padding: 0, margin: "0 0 1rem", display: "grid", gap: "0.5rem" }}>
          {messages.map((message) => (
            <li
              key={message.id}
              style={{
                justifySelf: message.sender === "customer" ? "end" : "start",
                maxWidth: "85%",
                padding: "0.5rem 0.75rem",
                borderRadius: 12,
                background: message.sender === "customer" ? "var(--color-muted)" : "var(--color-surface)",
                border: "1px solid var(--color-line)",
              }}
            >
              <small style={{ display: "block", opacity: 0.75 }}>
                {message.sender === "customer" ? "You" : storeName} · {time(message.createdAt)}
              </small>
              <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.body}</span>
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={send} style={{ display: "grid", gap: "0.5rem" }}>
        <label htmlFor="order-message">Your message</label>
        <textarea
          id="order-message"
          value={draft}
          maxLength={1000}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={pending || !draft.trim()}>
          {pending ? "Sending…" : "Send"}
        </Button>
      </form>
    </FlowCard>
  );
}
