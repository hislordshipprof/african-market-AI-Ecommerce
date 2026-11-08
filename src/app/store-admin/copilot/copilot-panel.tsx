"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { confirmStockProposal, rejectStockProposal, sendCopilotMessage } from "@/lib/copilot/actions";
import type { StockProposalCard } from "@/lib/copilot/types";
import type { StoredMessage } from "@/lib/copilot/messages";

const KIND_LABEL: Record<StockProposalCard["kind"], string> = {
  restock: "Restock",
  counter_sale: "Counter sale",
  recount: "Recount",
  set_status: "Status",
};

function changeLine(card: StockProposalCard): string {
  if (card.kind === "set_status") {
    const from = card.beforeStatus?.replaceAll("_", " ") ?? "unknown";
    const to = card.afterStatus?.replaceAll("_", " ") ?? "unknown";
    return `${from} to ${to}`;
  }
  const amount = card.kind === "recount" ? `to ${card.quantity ?? 0}` : `${card.quantity ?? 0}`;
  return `${KIND_LABEL[card.kind]} ${amount}: ${card.beforeQty ?? 0} to ${card.afterQty ?? 0}`;
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
  const [pending, startTransition] = useTransition();

  function send() {
    const draft = text;
    const messageId = crypto.randomUUID();
    startTransition(async () => {
      const result = await sendCopilotMessage({
        conversationId: conversationId ?? undefined,
        messageId,
        text: draft,
      });
      if (!result.ok) {
        setNotice(result.message);
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
    });
  }

  function decide(proposalId: string, action: "confirm" | "dismiss") {
    startTransition(async () => {
      if (action === "dismiss") {
        const result = await rejectStockProposal({ proposalId });
        if (!result.ok) {
          setNotice("That change is no longer waiting.");
          setProposals((current) => current.map((card) => card.id === proposalId ? { ...card, state: "expired" } : card));
          return;
        }
        setNotice(null);
        setProposals((current) => current.map((card) => card.id === proposalId ? { ...card, state: "rejected" } : card));
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
          setProposals((current) => current.map((card) => card.id === proposalId ? { ...card, state: "expired" } : card));
        }
        return;
      }
      setNotice(null);
      setProposals((current) => current.map((card) => card.id === proposalId ? result.proposal : card));
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Report stock</h2>
        <p className="text-sm text-muted-foreground">
          Type what came in or what you counted. Nothing changes until you tap Confirm.
        </p>
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && text.trim()) send();
        }}
      >
        <label htmlFor="copilot-report" className="text-sm font-medium text-foreground">
          Stock report
        </label>
        <textarea
          id="copilot-report"
          name="report"
          value={text}
          maxLength={1000}
          rows={3}
          disabled={pending}
          onChange={(event) => setText(event.target.value)}
          placeholder="Got 20 bags of gari"
          className="min-h-24 w-full rounded-lg border border-border bg-card px-3 py-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <Button type="submit" disabled={pending || text.trim().length === 0} className="min-h-11 self-start px-4">
          {pending ? "Sending" : "Send"}
        </Button>
      </form>

      {notice ? <p className="text-sm text-destructive" role="status">{notice}</p> : null}

      <section className="flex flex-col gap-3" aria-label="Proposed changes">
        {proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No changes waiting.</p>
        ) : proposals.map((card) => (
          <article key={card.id} className="rounded-lg border border-border bg-card p-4">
            <h3 className="text-base font-semibold text-foreground">{card.listingName}</h3>
            <p className="mt-1 text-sm text-foreground">{changeLine(card)}</p>
            <p className="mt-1 text-xs capitalize text-muted-foreground">{card.state}</p>
            {card.state === "pending" ? (
              <div className="mt-3 flex gap-2">
                <Button type="button" disabled={pending} className="min-h-11 px-4" onClick={() => decide(card.id, "confirm")}>
                  Confirm
                </Button>
                <Button type="button" variant="outline" disabled={pending} className="min-h-11 px-4" onClick={() => decide(card.id, "dismiss")}>
                  Dismiss
                </Button>
              </div>
            ) : null}
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-3" aria-label="Conversation">
        {messages.map((message, index) => (
          <p
            key={`${message.role}-${index}`}
            className={message.role === "owner"
              ? "whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2 text-sm text-foreground"
              : "whitespace-pre-wrap text-sm text-foreground"}
          >
            {message.text}
          </p>
        ))}
      </section>
    </div>
  );
}
