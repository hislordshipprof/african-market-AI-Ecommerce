"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useReducedMotion } from "motion/react";
import { Sheet } from "../sheet";
import { ProductImage } from "../product-image";
import { completionAnnouncement } from "@/lib/assistant/ui/announce";
import { cardsFromParts, cartToolCallIds, type AssistantCard } from "@/lib/assistant/ui/cards";
import { retainSession } from "@/lib/assistant/ui/chat-session";
import { refreshStoreCart } from "@/lib/assistant/ui/cart-bridge";
import { createSendLock, outgoingMessage } from "@/lib/assistant/ui/send";
import { planUndo, undoCardAfter, type UndoAck } from "@/lib/assistant/ui/undo";
import { replaceUndoLabels, undoLabelsForStore } from "@/lib/assistant/ui/undo-memory";
import { AssistantRouteError, mapRouteError, type RouteView } from "@/lib/assistant/ui/route-errors";
import { undoAssistantAdditionAction } from "@/lib/cart/actions";
import type { CartLine } from "@/lib/storefront/cart-store";
import styles from "./assistant.module.css";

export const ASSISTANT_CHUNK = "assistant-chat-chunk-v1";

const STARTERS = [
  { label: "Cook a dish", text: "I want to cook " },
  { label: "Restock my usual", text: "Restock my usual: " },
  { label: "Show me pictures", text: "Show me pictures of " },
] as const;

function messageId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function textOf(message: UIMessage): string {
  return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

function spoken(message: UIMessage): string {
  return completionAnnouncement(message);
}

export function AssistantSheet({
  open,
  onClose,
  storeId,
  accountId,
  cartId,
  loading,
  attention,
  lines,
  onCartFailure,
  onTerminal,
}: {
  open: boolean;
  onClose: () => void;
  storeId: string;
  accountId: string | null;
  cartId: string | null;
  loading: boolean;
  attention: boolean;
  lines: readonly CartLine[];
  onCartFailure: (failure: { error?: string; thrown?: unknown }) => void;
  onTerminal: () => void;
}) {
  const chat = useMemo(
    () => retainSession({ storeId, accountId, cartId, loading }),
    [storeId, accountId, cartId, loading],
  );
  void attention;
  return (
    <Sheet open={open} onClose={onClose} title="Shop with help">
      <Thread
        key={chat.id}
        chat={chat}
        storeId={storeId}
        loading={loading}
        lines={lines}
        onCartFailure={onCartFailure}
        onTerminal={onTerminal}
        onClose={onClose}
        open={open}
      />
    </Sheet>
  );
}

function Thread({
  chat,
  storeId,
  loading,
  lines,
  onCartFailure,
  onTerminal,
  onClose,
  open,
}: {
  chat: ReturnType<typeof retainSession>;
  storeId: string;
  loading: boolean;
  lines: readonly CartLine[];
  onCartFailure: (failure: { error?: string; thrown?: unknown }) => void;
  onTerminal: () => void;
  onClose: () => void;
  open: boolean;
}) {
  const { messages, sendMessage, status, error, clearError } = useChat({ chat });
  const reduced = useReducedMotion();
  const composer = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const sendLock = useRef(createSendLock());
  const [localError, setLocalError] = useState<string | null>(null);
  const seenTools = useRef(new Set<string>());
  const announced = useRef(new Set<string>());
  const [lastSent, setLastSent] = useState<{ id: string; text: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [trackedStore, setTrackedStore] = useState(storeId);
  const [undoState, setUndoState] = useState(() => undoLabelsForStore(storeId));
  if (trackedStore !== storeId) {
    setTrackedStore(storeId);
    setUndoState(undoLabelsForStore(storeId));
  }
  function rememberUndoState(update: (current: Record<string, "undone" | "already_removed">) => Record<string, "undone" | "already_removed">) {
    setUndoState((current) => {
      const next = update(current);
      replaceUndoLabels(storeId, next);
      return next;
    });
  }
  const liveRef = useRef<HTMLParagraphElement>(null);
  const busy = status === "submitted" || status === "streaming";
  const routeError: RouteView | null = error ? viewFor(error) : null;

  useEffect(() => {
    if (routeError?.terminal) onTerminal();
  }, [routeError?.terminal, onTerminal]);

  useEffect(() => {
    const fresh = messages.flatMap((message) => cartToolCallIds(message.parts));
    const unseen = fresh.filter((id) => !seenTools.current.has(id));
    if (unseen.length === 0) return;
    for (const id of unseen) seenTools.current.add(id);
    void refreshStoreCart(storeId);
  }, [messages, storeId]);

  useEffect(() => {
    if (busy) return;
    const last = [...messages].reverse().find((message) => message.role === "assistant");
    if (!last || announced.current.has(last.id)) return;
    announced.current.add(last.id);
    if (liveRef.current) liveRef.current.textContent = spoken(last);
  }, [messages, busy]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => composer.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  async function submit(text: string, id = messageId()) {
    if (loading || busy || routeError?.terminal) return;
    if (!sendLock.current.tryBegin()) return;
    try {
      const outgoing = outgoingMessage({ id, text });
      if (!outgoing.ok) {
        if (outgoing.reason === "too_long") setLocalError("Couldn't send that.");
        return;
      }
      setLocalError(null);
      const sent = outgoing.body.message.parts[0].text;
      setLastSent({ id, text: sent });
      setDraft("");
      clearError();
      const exists = messages.some((message) => message.id === id);
      if (exists) await sendMessage({ text: sent, messageId: id });
      else await sendMessage({ id, role: "user", parts: [{ type: "text", text: sent }] });
    } finally {
      sendLock.current.end();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || composing.current || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit(draft);
  }

  return (
    <div className={styles.thread} data-chunk={ASSISTANT_CHUNK}>
      <p className={styles.live} aria-live="polite" ref={liveRef} />
      <div className={styles.log}>
        {messages.map((message, index) => (
          <MessageView
            key={message.id}
            message={message}
            undoState={undoState}
            disabled={!!routeError?.terminal || busy}
            turnFailed={status === "error" && message.role === "assistant" && index === messages.length - 1}
            onChoice={(text) => { void submit(text); }}
            onUndo={(card) => {
              void undoCard(card, lines, storeId, undoState, rememberUndoState, onCartFailure);
            }}
            onChange={() => composer.current?.focus()}
            onClose={onClose}
          />
        ))}
        {busy ? (
          <p className={styles.typing} data-motion={reduced ? "off" : "on"}>Working</p>
        ) : null}
      </div>
      {messages.length === 0 ? (
        <div className={styles.starters}>
          {STARTERS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              className={styles.chip}
              disabled={!!routeError?.terminal}
              onClick={() => {
                setDraft(starter.text);
                composer.current?.focus();
              }}
            >
              {starter.label}
            </button>
          ))}
        </div>
      ) : null}
      {localError ? <p className={styles.meta}>{localError}</p> : null}
      {routeError ? (
        <div className={styles.notice} role="status">
          <p>{routeError.title}</p>
          <a href={routeError.searchHref}>Search the shelves</a>
          {routeError.retry && lastSent ? (
            <button
              type="button"
              className={styles.ghost}
              onClick={() => {
                void submit(lastSent.text, lastSent.id);
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(draft);
        }}
      >
        <label className="sr-only" htmlFor="assistant-composer">Message</label>
        <textarea
          id="assistant-composer"
          ref={composer}
          data-testid="assistant-composer"
          maxLength={2000}
          value={draft}
          disabled={!!routeError?.terminal}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className={styles.send}
          data-testid="assistant-send"
          disabled={!!routeError?.terminal || busy || loading || draft.trim().length === 0}
        >
          Send
        </button>
      </form>
    </div>
  );
}

function viewFor(error: Error): RouteView {
  const source = error instanceof AssistantRouteError
    ? error
    : error.cause instanceof AssistantRouteError
      ? error.cause
      : null;
  return source
    ? mapRouteError({ code: source.code, retryAfter: source.retryAfter, parsed: source.parsed })
    : mapRouteError({ network: true });
}

function MessageView({
  message,
  undoState,
  disabled,
  turnFailed,
  onChoice,
  onUndo,
  onChange,
  onClose,
}: {
  message: UIMessage;
  undoState: Record<string, "undone" | "already_removed">;
  disabled: boolean;
  turnFailed: boolean;
  onChoice: (text: string) => void;
  onUndo: (card: Extract<AssistantCard, { kind: "added" }>) => void;
  onChange: () => void;
  onClose: () => void;
}) {
  if (message.role === "user") {
    return <p className={`${styles.bubble} ${styles.user}`}>{textOf(message)}</p>;
  }
  return (
    <div className={styles.message}>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          return part.text ? <p key={`${message.id}-text-${index}`} className={styles.bubble}>{part.text}</p> : null;
        }
        const cards = cardsFromParts([part], { turnFailed });
        if (cards.length === 0) return null;
        return (
          <div key={`${message.id}-cards-${index}`} className={styles.cards}>
            {cards.map((card) => (
              <CardView
                key={card.key}
                card={card}
                undoLabel={card.kind === "added" ? undoState[card.additionId] : undefined}
                disabled={disabled}
                onChoice={onChoice}
                onUndo={onUndo}
                onChange={onChange}
                onClose={onClose}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function CardView({
  card,
  undoLabel,
  disabled,
  onChoice,
  onUndo,
  onChange,
  onClose,
}: {
  card: AssistantCard;
  undoLabel?: "undone" | "already_removed";
  disabled: boolean;
  onChoice: (text: string) => void;
  onUndo: (card: Extract<AssistantCard, { kind: "added" }>) => void;
  onChange: () => void;
  onClose: () => void;
}) {
  if (card.kind === "skeleton") return <div className={styles.skeleton} />;
  if (card.kind === "tool-error" || card.kind === "missing") {
    return <p className={styles.notice}>{card.message}</p>;
  }
  if (card.kind === "product") {
    return (
      <article className={styles.card}>
        {card.imageUrl ? (
          <ProductImage src={card.imageUrl} name={card.name} sizes="64px" />
        ) : (
          <div className={styles.placeholder}>No photo yet</div>
        )}
        <div className={styles.copy}>
          <h3>{card.name}</h3>
          <p className={styles.meta}>{card.packLabel}</p>
          <p className={styles.price}>{card.priceLabel}</p>
          {card.mayBeUnavailable ? <p className={styles.flag}>May be unavailable</p> : null}
        </div>
      </article>
    );
  }
  if (card.kind === "added") {
    const label = undoLabel === "undone" ? "Undone" : undoLabel === "already_removed" ? "Already removed" : "Undo";
    return (
      <article className={styles.card}>
        <div className={styles.placeholder}>Added</div>
        <div className={styles.copy}>
          <h3>{card.name}</h3>
          <p className={styles.meta}>{[card.packLabel, `Qty ${card.qtyAdded}`].filter(Boolean).join(" · ")}</p>
          {card.limitedTo != null ? <p className={styles.flag}>Limited to {card.limitedTo}</p> : null}
          <button type="button" className={styles.undo} disabled={disabled || label !== "Undo"} onClick={() => onUndo(card)}>
            {label}
          </button>
        </div>
      </article>
    );
  }
  if (card.kind === "choices") {
    return (
      <div className={styles.choiceRow} aria-label="Choice chips">
        {card.options.map((option) => (
          <button
            key={option.choiceId}
            type="button"
            className={styles.chip}
            disabled={disabled}
            onClick={() => onChoice(option.sendText)}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <section className={styles.summary}>
      <h3>Your basket</h3>
      <ul>
        {card.lines.map((line) => (
          <li key={line.lineId}>
            <span>{line.qty} × {line.name}</span>
            <span>{line.lineTotalLabel}</span>
          </li>
        ))}
      </ul>
      <p className={styles.price}>{card.subtotalLabel}</p>
      {card.gapLabel ? <p className={styles.meta}>{card.gapLabel}</p> : null}
      <div className={styles.actions}>
        <Link className={styles.primary} href="/cart" onClick={onClose}>Looks good</Link>
        <button type="button" className={styles.ghost} onClick={onChange}>Change something</button>
      </div>
    </section>
  );
}

async function undoCard(
  card: Extract<AssistantCard, { kind: "added" }>,
  lines: readonly CartLine[],
  storeId: string,
  undoState: Record<string, "undone" | "already_removed">,
  setUndoState: (value: (current: Record<string, "undone" | "already_removed">) => Record<string, "undone" | "already_removed">) => void,
  onCartFailure: (failure: { error?: string; thrown?: unknown }) => void,
) {
  const line = lines.find((item) => item.serverLineId === card.lineId);
  const plan = planUndo({
    read: "confirmed",
    line: { lineId: card.lineId, qty: line?.quantity ?? card.qtyAdded },
    added: card.qtyAdded,
    additionId: card.additionId,
    consumed: undoState[card.additionId] === "undone",
  });
  if (plan.action === "skip") {
    const label = plan.label === "Undone" ? "undone" : "already_removed";
    setUndoState((current) => ({ ...current, [card.additionId]: label }));
    return;
  }
  if (plan.action !== "submit") return;
  let ack: UndoAck;
  try {
    const result = await undoAssistantAdditionAction({
      lineId: plan.lineId,
      added: plan.added,
      additionId: plan.additionId,
    });
    if (!result.ok) {
      onCartFailure({ error: result.error });
      return;
    }
    ack = result.result;
  } catch (error) {
    onCartFailure({ thrown: error });
    return;
  }
  let refresh: "ok" | "failed" = "ok";
  try {
    await refreshStoreCart(storeId);
  } catch {
    refresh = "failed";
  }
  const view = undoCardAfter(ack, refresh);
  if (view === "unchanged") return;
  const label = view === "undone" ? "undone" : "already_removed";
  setUndoState((current) => ({ ...current, [card.additionId]: label }));
}
