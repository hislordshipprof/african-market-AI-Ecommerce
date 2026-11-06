"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { ArrowUp, Mic, Square } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { Sheet } from "../sheet";
import { ProductImage } from "../product-image";
import { completionAnnouncement } from "@/lib/assistant/ui/announce";
import { cardsFromParts, cartToolCallIds, type AssistantCard } from "@/lib/assistant/ui/cards";
import { retainSession } from "@/lib/assistant/ui/chat-session";
import { refreshStoreCart } from "@/lib/assistant/ui/cart-bridge";
import { dataUrl, fileNotice, jpegBlob, pdfPages, roomFor, type PreparedFile } from "@/lib/assistant/ui/client-files";
import { createSendLock, outgoingMessage } from "@/lib/assistant/ui/send";
import {
  abortSpeech,
  beginSpeech,
  bindRecognizer,
  commitInterim,
  noteCustomerEdit,
  recognitionLanguage,
  stopSpeech,
  type BrowserSpeech,
  type SpeechState,
} from "@/lib/assistant/ui/speech";
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
  { label: "Snap your shopping list", text: "Here is my shopping list: " },
  { label: "Send a recipe PDF", text: "Here is a recipe: " },
] as const;

const FILE_NOTE = "Read once to answer you. We don't save your files. Please don't send cards or IDs.";
const LISTENING_NOTE = "Your browser turns your speech into text. Check it, then send.";

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
  const [speech, setSpeech] = useState<SpeechState | null>(null);
  const [micHidden, setMicHidden] = useState(false);
  const micDetected = useSyncExternalStore(
    () => () => {},
    () => {
      const host = window as Window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
      return Boolean(host.SpeechRecognition ?? host.webkitSpeechRecognition);
    },
    () => false,
  );
  const micReady = micDetected && !micHidden;
  const [keyboardInset, setKeyboardInset] = useState(0);
  const speechRef = useRef<SpeechState | null>(null);
  const recognizerRef = useRef<BrowserSpeech | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [tiles, setTiles] = useState<Array<PreparedFile & { preview: string }>>([]);
  const [addOpen, setAddOpen] = useState(false);
  const tilesRef = useRef(tiles);
  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);
  const cameraInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
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

  function publishSpeech(next: SpeechState) {
    speechRef.current = next;
    setSpeech(next);
    setDraft(next.draft);
    if (next.notice) setLocalError(next.notice);
    if (next.listening && liveRef.current) liveRef.current.textContent = "Listening";
  }

  function stopListening(mode: "stop" | "abort") {
    const current = speechRef.current;
    const recognizer = recognizerRef.current;
    if (!current) return;
    if (mode === "abort") {
      publishSpeech(abortSpeech(current, current.session + 1));
      recognizer?.abort();
      return;
    }
    publishSpeech(stopSpeech(current));
    recognizer?.stop();
  }

  useEffect(() => {
    if (open) return;
    stopListening("abort");
    const current = tilesRef.current;
    const timer = window.setTimeout(() => {
      for (const tile of current) {
        if (tile.preview) URL.revokeObjectURL(tile.preview);
      }
      setTiles([]);
      setAddOpen(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => () => {
    for (const tile of tilesRef.current) {
      if (tile.preview) URL.revokeObjectURL(tile.preview);
    }
  }, []);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") stopListening("abort");
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      recognizerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!speech?.listening) return;
    const timer = window.setTimeout(() => stopListening("stop"), 60_000);
    return () => window.clearTimeout(timer);
  }, [speech?.listening, speech?.session]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !open) return;
    const apply = () => {
      const overlap = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      setKeyboardInset(overlap);
    };
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
    };
  }, [open]);

  async function takeFiles(list: FileList | null) {
    setAddOpen(false);
    if (!list || list.length === 0) return;
    const room = roomFor(tilesRef.current.length);
    if (list.length > room) setLocalError(fileNotice("too-many"));
    const chosen = [...list].slice(0, room);
    for (const file of chosen) {
      const id = messageId();
      const pdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (pdf) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await pdfPages(bytes);
        if ("message" in result) {
          setTiles((current) => [...current, {
            id, name: file.name, filename: file.name, mediaType: "application/pdf", url: "", preview: "", status: "invalid", message: result.message,
          }]);
          continue;
        }
        const preview = URL.createObjectURL(file);
        const url = await dataUrl(new Blob([bytes], { type: "application/pdf" }));
        setTiles((current) => [...current, {
          id, name: file.name, filename: file.name, mediaType: "application/pdf", url, preview, status: "ready", message: null,
        }]);
        continue;
      }
      try {
        const blob = await jpegBlob(file);
        const preview = URL.createObjectURL(blob);
        const url = await dataUrl(blob);
        setTiles((current) => [...current, {
          id, name: file.name || "photo.jpg", filename: "photo.jpg", mediaType: "image/jpeg", url, preview, status: "ready", message: null,
        }]);
      } catch {
        setTiles((current) => [...current, {
          id, name: file.name || "photo", filename: "photo.jpg", mediaType: "image/jpeg", url: "", preview: "", status: "invalid", message: fileNotice("undecodable"),
        }]);
      }
    }
  }

  function removeTile(id: string) {
    setTiles((current) => {
      const tile = current.find((item) => item.id === id);
      if (tile?.preview) URL.revokeObjectURL(tile.preview);
      return current.filter((item) => item.id !== id);
    });
  }

  function toggleMic() {
    if (speechRef.current?.listening) {
      stopListening("stop");
      return;
    }
    const host = window as Window & {
      SpeechRecognition?: new () => BrowserSpeech;
      webkitSpeechRecognition?: new () => BrowserSpeech;
    };
    const Ctor = host.SpeechRecognition ?? host.webkitSpeechRecognition;
    if (!Ctor) {
      setMicHidden(true);
      return;
    }
    const session = (speechRef.current?.session ?? 0) + 1;
    const started = beginSpeech(draft, session);
    publishSpeech(started);
    const recognizer = new Ctor();
    recognizerRef.current = recognizer;
    try {
      bindRecognizer(recognizer, {
        lang: recognitionLanguage(document.documentElement.lang, navigator.language),
        session,
        read: () => speechRef.current ?? started,
        write: publishSpeech,
      });
    } catch {
      publishSpeech(stopSpeech(started));
      setLocalError("Microphone access is off. You can type instead.");
    }
  }

  async function submit(text: string, id = messageId()) {
    if (speechRef.current?.listening) {
      publishSpeech(commitInterim(speechRef.current));
      recognizerRef.current?.stop();
      return;
    }
    if (loading || busy || routeError?.terminal) return;
    if (!sendLock.current.tryBegin()) return;
    try {
      const ready = tiles.filter((tile) => tile.status === "ready");
      if (tiles.some((tile) => tile.status === "invalid")) return;
      const outgoing = outgoingMessage({
        id,
        text,
        files: ready.map((tile) => ({ type: "file", mediaType: tile.mediaType, filename: tile.filename, url: tile.url })),
      });
      if (!outgoing.ok) {
        if (outgoing.reason === "too_long") setLocalError("Couldn't send that.");
        return;
      }
      setLocalError(null);
      const textPart = outgoing.body.message.parts.find((part) => part.type === "text");
      const sent = textPart?.type === "text" ? textPart.text : "";
      setLastSent({ id, text: sent });
      setDraft("");
      for (const tile of tiles) {
        if (tile.preview) URL.revokeObjectURL(tile.preview);
      }
      setTiles([]);
      clearError();
      const exists = messages.some((message) => message.id === id);
      if (exists && ready.length === 0) await sendMessage({ text: sent, messageId: id });
      else await sendMessage({ id, role: "user", parts: outgoing.body.message.parts });
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
    <div className={styles.thread} data-chunk={ASSISTANT_CHUNK} style={{ paddingBottom: keyboardInset }}>
      <p className={styles.live} aria-live="polite" ref={liveRef} />
      <div
        className={styles.log}
        ref={logRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          setAwayFromLatest(node.scrollHeight - node.scrollTop - node.clientHeight > 48);
        }}
      >
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
          <p className={styles.typing} data-motion={reduced ? "off" : "on"}>{waitingLabel(messages)}</p>
        ) : null}
      </div>
      {awayFromLatest ? (
        <button
          type="button"
          className={styles.jump}
          onClick={() => {
            const node = logRef.current;
            if (!node) return;
            node.scrollTo({ top: node.scrollHeight, behavior: reduced ? "auto" : "smooth" });
          }}
        >
          Jump to latest
        </button>
      ) : null}
      {messages.length === 0 ? (
        <p className={styles.bubble}>What are you cooking or restocking?</p>
      ) : null}
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
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void takeFiles(event.dataTransfer.files);
        }}
        onPaste={(event) => {
          if (event.clipboardData.files.length === 0) return;
          event.preventDefault();
          void takeFiles(event.clipboardData.files);
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
          onChange={(event) => {
            const next = event.target.value;
            if (speechRef.current) {
              const edited = noteCustomerEdit(speechRef.current, next);
              speechRef.current = edited;
              setSpeech(edited);
            }
            setDraft(next);
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={onKeyDown}
        />
        {tiles.length > 0 ? (
          <div className={styles.tiles}>
            {tiles.map((tile) => (
              <div key={tile.id} className={styles.tile} data-status={tile.status}>
                {tile.preview && tile.mediaType === "image/jpeg" ? <img src={tile.preview} alt="" /> : null}
                <p>{tile.name}</p>
                <p>{tile.mediaType === "application/pdf" ? "PDF" : "Photo"}</p>
                {tile.message ? <p>{tile.message}</p> : null}
                <button type="button" onClick={() => removeTile(tile.id)}>Remove {tile.name}</button>
              </div>
            ))}
          </div>
        ) : null}
        {speech?.interim ? <p className={styles.interim}>{speech.interim}</p> : null}
        {addOpen ? (
          <div className={styles.addMenu}>
            <button type="button" onClick={() => cameraInput.current?.click()}>Camera</button>
            <button type="button" onClick={() => photoInput.current?.click()}>Photos</button>
            <button type="button" onClick={() => pdfInput.current?.click()}>PDF</button>
          </div>
        ) : null}
        <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(event) => { void takeFiles(event.target.files); event.target.value = ""; }} />
        <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(event) => { void takeFiles(event.target.files); event.target.value = ""; }} />
        <input ref={pdfInput} type="file" accept="application/pdf" hidden onChange={(event) => { void takeFiles(event.target.files); event.target.value = ""; }} />
        <div className={styles.tools}>
          <button
            type="button"
            className={styles.tool}
            aria-label="Add a photo or PDF"
            aria-expanded={addOpen}
            disabled={!!routeError?.terminal}
            onClick={() => setAddOpen((openMenu) => !openMenu)}
          >
            Add
          </button>
          {micReady ? (
            <button
              type="button"
              className={styles.tool}
              aria-pressed={speech?.listening === true}
              aria-label={speech?.listening ? "Stop listening" : "Start listening"}
              data-motion={reduced ? "off" : "on"}
              onClick={toggleMic}
            >
              {speech?.listening ? <Square size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
            </button>
          ) : null}
          <button
            type="submit"
            className={styles.send}
            data-testid="assistant-send"
            aria-label="Send"
            disabled={!!routeError?.terminal || busy || loading || tiles.some((tile) => tile.status === "invalid") || (!speech?.listening && draft.trim().length === 0 && tiles.every((tile) => tile.status !== "ready"))}
          >
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </div>
        <p className={styles.note}>{FILE_NOTE}</p>
        {speech?.listening ? <p className={styles.note}>{LISTENING_NOTE}</p> : null}
      </form>
    </div>
  );
}

function waitingLabel(messages: UIMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (lastUser?.parts.some((part) => part.type === "file")) return "Reading your list";
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (assistant && JSON.stringify(assistant.parts).includes("search_catalog")) return "Checking the shelves";
  return "Working";
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
    const files = message.parts.flatMap((part) => part.type === "file" ? [part] : []);
    const text = textOf(message);
    return (
      <div className={`${styles.bubble} ${styles.user}`}>
        {files.map((file) => (
          file.mediaType.startsWith("image/")
            ? <img key={file.url} className={styles.photo} src={file.url} alt="" />
            : <p key={`${file.filename ?? "file"}-${file.url}`} className={styles.fileChip}>{file.filename ?? "PDF"}</p>
        ))}
        {text ? <p>{text}</p> : null}
      </div>
    );
  }
  return (
    <div className={styles.message}>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          return part.text ? <p key={`${message.id}-text-${index}`} className={styles.bubble}>{part.text}</p> : null;
        }
        const cards = cardsFromParts([part], { turnFailed });
        if (cards.length === 0) return null;
        const products = cards.filter((card) => card.kind === "product");
        const added = cards.filter((card) => card.kind === "added");
        const rest = cards.filter((card) => card.kind !== "product" && card.kind !== "added");
        return (
          <div key={`${message.id}-cards-${index}`}>
            {products.length > 0 ? (
              <>
                <div className={styles.cards}>
                  {products.map((card) => (
                    <CardView key={card.key} card={card} disabled={disabled} onChoice={onChoice} onUndo={onUndo} onChange={onChange} onClose={onClose} />
                  ))}
                </div>
                <Link className={styles.seeAll} href="/search">See all</Link>
              </>
            ) : null}
            {added.length > 0 ? (
              <div className={styles.addedRow}>
                {added.map((card) => (
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
            ) : null}
            {rest.map((card) => (
              <CardView
                key={card.key}
                card={card}
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
