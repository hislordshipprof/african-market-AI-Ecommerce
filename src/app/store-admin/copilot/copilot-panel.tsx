"use client";

import { useState, useTransition } from "react";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmStockProposal, rejectStockProposal, sendCopilotMessage } from "@/lib/copilot/actions";
import type { StoredMessage } from "@/lib/copilot/messages";
import type { StockProposalCard } from "@/lib/copilot/types";

const KIND: Record<StockProposalCard["kind"], string> = {
  restock: "Restock",
  counter_sale: "Counter sale",
  recount: "Recount",
  set_status: "Status",
};

function shelfLine(card: StockProposalCard): string {
  if (card.kind === "set_status") {
    const from = (card.beforeStatus ?? "unknown").replaceAll("_", " ");
    const to = (card.afterStatus ?? "unknown").replaceAll("_", " ");
    return `${from} → ${to}`;
  }
  return `${card.beforeQty ?? 0} → ${card.afterQty ?? 0}`;
}

function plain(text: string): string {
  return text.replaceAll("**", "").replaceAll("`", "");
}

function stateLine(state: StockProposalCard["state"]): string {
  if (state === "confirmed") return "On the shelf";
  if (state === "rejected") return "Dismissed";
  if (state === "expired") return "Expired. Send it again.";
  return "Waiting for you";
}

export function CopilotPanel({
  conversationId: initialConversationId,
  messages: initialMessages,
  proposals: initialProposals,
}: {
  conversationId: string | null;
  messages: StoredMessage[];
  proposals: StockProposalCard[];
}) {
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [messages, setMessages] = useState(initialMessages);
  const [proposals, setProposals] = useState(initialProposals);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | { kind: "send" } | { kind: "confirm" | "dismiss"; id: string }>(null);
  const [pending, startTransition] = useTransition();
  const trimmed = text.trim();
  const waiting = proposals.filter((card) => card.state === "pending");
  const settled = proposals.filter((card) => card.state !== "pending");

  function send() {
    const draft = text;
    const messageId = crypto.randomUUID();
    setBusy({ kind: "send" });
    startTransition(async () => {
      const result = await sendCopilotMessage({
        conversationId: conversationId ?? undefined,
        messageId,
        text: draft,
      });
      if (!result.ok) {
        setNotice(result.message);
        setBusy(null);
        return;
      }
      setNotice(null);
      setText("");
      setConversationId(result.conversationId);
      setMessages((current) => [
        ...current,
        { role: "owner", text: draft.trim() },
        { role: "assistant", text: result.reply },
      ]);
      setProposals((current) => [...result.proposals, ...current]);
      setBusy(null);
    });
  }

  function decide(proposalId: string, action: "confirm" | "dismiss") {
    setBusy({ kind: action, id: proposalId });
    startTransition(async () => {
      if (action === "dismiss") {
        const result = await rejectStockProposal({ proposalId });
        if (result.ok) {
          setNotice(null);
          setProposals((current) => current.map((card) => (
            card.id === proposalId ? { ...card, state: "rejected" } : card
          )));
        } else {
          setNotice("That change is no longer waiting. Refresh the page if it already moved.");
        }
        setBusy(null);
        return;
      }
      const result = await confirmStockProposal({ proposalId });
      if (!result.ok) {
        setNotice(result.code === "too_large"
          ? "That number is too large for this item."
          : result.code === "expired"
            ? "That change expired. Send it again."
            : "That change is no longer waiting.");
        if (result.code === "expired" || result.code === "stale") {
          setProposals((current) => current.map((card) => (
            card.id === proposalId ? { ...card, state: "expired" } : card
          )));
        }
        setBusy(null);
        return;
      }
      setNotice(null);
      setProposals((current) => current.map((card) => card.id === proposalId ? result.proposal : card));
      setBusy(null);
    });
  }

  function confirmLabel(card: StockProposalCard): string {
    if (card.kind === "set_status") {
      const status = (card.afterStatus ?? "updated").replaceAll("_", " ");
      return `Mark ${status}`;
    }
    return `Put ${card.afterQty ?? 0} on the shelf`;
  }

  return (
    <div className="flex min-h-[calc(100dvh-4.75rem)] flex-col gap-8">
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-display text-[1.375rem] leading-tight font-bold text-balance text-foreground">
            Report stock
          </h2>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            className="min-h-11 rounded-full px-4"
            onClick={() => {
              setConversationId(null);
              setMessages([]);
              setNotice(null);
              setProposals((current) => current.filter((card) => card.state === "pending"));
            }}
          >
            New chat
          </Button>
        </div>
        <p className="max-w-[65ch] text-base leading-6 text-muted-foreground">
          Say what came in, what you sold at the counter, or what you counted. The shelf stays put until you tap Confirm.
        </p>

        {proposals.length === 0 && messages.length === 0 ? (
          <p className="rounded-xl border border-border bg-card px-4 py-5 text-base text-muted-foreground">
            Nothing waiting. Tell the copilot what came in or what you counted.
          </p>
        ) : null}
        {settled.length > 0 ? (
        <section aria-label="Settled changes" className="flex flex-col gap-3">
          {settled.map((card) => (
            <article key={card.id} className="rounded-xl border border-border bg-card px-4 py-4">
              <h3 className="font-display text-xl leading-tight font-bold text-foreground">{card.listingName}</h3>
              <p className="mt-2 font-display text-[1.75rem] leading-none font-bold tracking-tight text-foreground tabular-nums">
                {shelfLine(card)}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">{KIND[card.kind]} · {stateLine(card.state)}</p>
            </article>
          ))}
        </section>
        ) : null}

        {messages.length > 0 ? (
          <section aria-label="Conversation" className="flex flex-col gap-3">
            {messages.map((message, index) => (
              <p
                key={`${message.role}-${index}`}
                className={message.role === "owner"
                  ? "max-w-[65ch] whitespace-pre-wrap rounded-xl bg-muted px-4 py-3 text-base leading-6 text-foreground"
                  : "max-w-[65ch] whitespace-pre-wrap text-base leading-6 text-foreground"}
              >
                <span className="mb-1 block text-[0.8125rem] font-semibold">{message.role === "owner" ? "You" : "Copilot"}</span>
                {plain(message.text)}
              </p>
            ))}
          </section>
        ) : null}
      </div>

      <form
        className="-mx-4 mt-auto border-t border-border bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && trimmed) send();
        }}
      >
        {waiting.length > 0 ? (
          <div className="mb-4 flex flex-col gap-3" aria-label="Waiting for you">
            {waiting.map((card) => {
              const writing = busy?.kind === "confirm" && busy.id === card.id;
              return (
                <article key={card.id} className="rounded-xl border border-border bg-card px-4 py-4">
                  <h3 className="font-display text-xl leading-tight font-bold text-foreground">{card.listingName}</h3>
                  <p className="mt-2 font-display text-[1.75rem] leading-none font-bold tracking-tight text-foreground tabular-nums">
                    {shelfLine(card)}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {KIND[card.kind]} · {writing ? "Writing the shelf…" : stateLine(card.state)}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={pending}
                      className="min-h-12 rounded-full px-6"
                      onClick={() => decide(card.id, "confirm")}
                    >
                      {confirmLabel(card)}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending}
                      className="min-h-12 rounded-full px-6"
                      onClick={() => decide(card.id, "dismiss")}
                    >
                      Dismiss
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
        {notice ? (
          <p className="mb-3 flex items-start gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </p>
        ) : null}
        <label htmlFor="copilot-report" className="text-[0.8125rem] font-semibold text-foreground">
          Stock report
        </label>
        <textarea
          id="copilot-report"
          name="report"
          value={text}
          maxLength={1000}
          rows={2}
          disabled={pending}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          placeholder="Got 20 bags of gari"
          className="mt-2 min-h-16 w-full resize-none rounded-xl border border-border bg-card px-3 py-3 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-[0.8125rem] text-muted-foreground tabular-nums" aria-live="polite">
            {text.length > 0 ? `${text.length} / 1000` : "Up to 1,000 characters"}
          </p>
          <Button type="submit" disabled={pending || trimmed.length === 0} className="min-h-12 rounded-full px-6">
            {busy?.kind === "send" ? "Sending" : "Send"}
          </Button>
        </div>
      </form>
    </div>
  );
}
