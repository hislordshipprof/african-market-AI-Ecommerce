"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { ArrowUp, FileText, Mic, Square, X } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { Sheet } from "../sheet";
import { ProductImage } from "../product-image";
import { QuickAddStepper } from "../quick-add-stepper";
import { AssistantMarkdown } from "./assistant-markdown";
import { completionAnnouncement } from "@/lib/assistant/ui/announce";
import { cardsFromParts, cartToolCallIds, type AssistantCard } from "@/lib/assistant/ui/cards";
import {
  acknowledgeUndo,
  commitUndoLabel,
  EMPTY_SESSION_SNAPSHOT,
  noteAcceptedSend,
  partsForRetry,
  retainSession,
  retryOffer,
  sessionSnapshot,
  subscribeSessionMemory,
} from "@/lib/assistant/ui/chat-session";
import { refreshStoreCart } from "@/lib/assistant/ui/cart-bridge";
import { dataUrl, displayFileName, fileNotice, jpegBlob, pdfPages, postedPhotoName, roomFor, withinByteCap, type PreparedFile } from "@/lib/assistant/ui/client-files";
import { createSendLock, outgoingMessage, settleSend } from "@/lib/assistant/ui/send";
import {
  abortSpeech,
  beginSpeech,
  bindRecognizer,
  commitInterim,
  noteCustomerEdit,
  recognitionLanguage,
  sealSpeech,
  stopSpeech,
  type BrowserSpeech,
  type SpeechState,
} from "@/lib/assistant/ui/speech";
import { planUndo, type UndoAck } from "@/lib/assistant/ui/undo";
import { AssistantRouteError, mapRouteError, type RouteView } from "@/lib/assistant/ui/route-errors";
import { undoAssistantAdditionAction } from "@/lib/cart/actions";
import type { CartLine } from "@/lib/storefront/cart-store";
import styles from "./assistant.module.css";

export const ASSISTANT_CHUNK = "assistant-chat-chunk-v1";

const STARTERS = [
  { label: "Cook a dish", text: "I want to cook " },
  { label: "Restock my usual", text: "Restock my usual: " },
  { label: "Snap your shopping list", text: "Here is my shopping list: " },
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
  storeName,
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
  storeName: string;
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
    <Sheet open={open} onClose={onClose} title="Shop with AI">
      <Thread
        key={chat.id}
        chat={chat}
        storeId={storeId}
        storeName={storeName}
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
  storeName,
  loading,
  lines,
  onCartFailure,
  onTerminal,
  onClose,
  open,
}: {
  chat: ReturnType<typeof retainSession>;
  storeId: string;
  storeName: string;
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
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
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
  const addWrap = useRef<HTMLDivElement>(null);
  // The menu floats over the sheet, so a tap or focus anywhere else closes it. That covers Send too.
  useEffect(() => {
    if (!addOpen) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && addWrap.current?.contains(event.target)) return;
      setAddOpen(false);
    };
    // Escape closes this menu first, wherever focus is: the sheet, and the draft in it, stay open.
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setAddOpen(false);
      addWrap.current?.querySelector("button")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [addOpen]);
  const tilesRef = useRef(tiles);
  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);
  const cameraInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const generationRef = useRef(0);
  const [generation, setGeneration] = useState(0);
  const revisionRef = useRef(0);
  type Flight = {
    id: string;
    text: string;
    tiles: Array<PreparedFile & { preview: string }>;
    revision: number;
    generation: number;
  };
  const [inflight, setInflight] = useState<Flight | null>(null);
  const inflightRef = useRef<Flight | null>(null);
  const revokedRef = useRef(new Set<string>());
  const memory = useSyncExternalStore(
    (listener) => subscribeSessionMemory(chat, listener),
    () => sessionSnapshot(chat),
    () => EMPTY_SESSION_SNAPSHOT,
  );
  const undoState = memory.labels;
  const liveRef = useRef<HTMLParagraphElement>(null);
  const busy = status === "submitted" || status === "streaming";
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  const routeError: RouteView | null = error ? viewFor(error) : null;
  const fileRetry = Boolean(
    inflight &&
    inflight.generation === generation &&
    inflight.tiles.length > 0,
  );
  const retry = routeError
    ? retryOffer(chat, {
        routeCode: routeError.code,
        terminal: routeError.terminal,
        openFileFlight: fileRetry && inflight ? { messageId: inflight.id, text: inflight.text } : null,
      })
    : null;

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

  function tileKey(list: Array<PreparedFile & { preview: string }>) {
    return list.map((tile) => `${tile.id}:${tile.status}:${tile.bytes}:${tile.preview}`).join("\n");
  }

  function changeDraft(text: string, nextTiles = tilesRef.current) {
    const textChanged = text !== draftRef.current;
    const filesChanged = tileKey(nextTiles) !== tileKey(tilesRef.current);
    if (!textChanged && !filesChanged) return;
    revisionRef.current += 1;
    draftRef.current = text;
    tilesRef.current = nextTiles;
    setDraft(text);
    setTiles(nextTiles);
  }

  function revokeOnce(list: Array<{ preview: string }>) {
    for (const tile of list) {
      if (!tile.preview || revokedRef.current.has(tile.preview)) continue;
      revokedRef.current.add(tile.preview);
      URL.revokeObjectURL(tile.preview);
    }
  }

  function ownsPreview(preview: string) {
    return Boolean(preview) && (inflightRef.current?.tiles.some((tile) => tile.preview === preview) ?? false);
  }

  function takeOwned() {
    const flight = inflightRef.current;
    const loose = tilesRef.current;
    inflightRef.current = null;
    draftRef.current = "";
    tilesRef.current = [];
    const seen = new Set<string>();
    const owned: Array<PreparedFile & { preview: string }> = [];
    for (const tile of [...loose, ...(flight?.tiles ?? [])]) {
      if (!tile.preview || seen.has(tile.preview)) continue;
      seen.add(tile.preview);
      owned.push(tile);
    }
    return owned;
  }

  function finish(outcome: "success" | "rejected") {
    const flight = inflightRef.current;
    const decision = settleSend({
      outcome,
      generation: generationRef.current,
      revision: revisionRef.current,
      flight,
    });
    if (!flight || decision.action === "ignore" || decision.action === "keep") return;
    if (decision.action === "revoke") {
      revokeOnce(flight.tiles);
      const owned = new Set(flight.tiles.map((tile) => tile.preview).filter(Boolean));
      if (revisionRef.current === flight.revision) {
        draftRef.current = "";
        setDraft("");
      }
      const remaining = tilesRef.current.filter((tile) => !tile.preview || !owned.has(tile.preview));
      if (revisionRef.current === flight.revision || remaining.length !== tilesRef.current.length) {
        tilesRef.current = remaining;
        setTiles(remaining);
      }
      inflightRef.current = null;
      setInflight(null);
      return;
    }
    draftRef.current = flight.text;
    tilesRef.current = flight.tiles;
    setDraft(flight.text);
    setTiles(flight.tiles);
    const spoken = speechRef.current;
    if (spoken?.accepting) {
      const edited = noteCustomerEdit(spoken, flight.text);
      speechRef.current = edited;
      setSpeech(edited);
    }
  }

  function publishSpeech(next: SpeechState) {
    speechRef.current = next;
    setSpeech(next);
    changeDraft(next.draft);
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
    generationRef.current += 1;
    setGeneration(generationRef.current);
    stopListening("abort");
    const owned = takeOwned();
    window.setTimeout(() => {
      revokeOnce(owned);
      setInflight(null);
      setDraft("");
      setTiles([]);
      setAddOpen(false);
    }, 0);
  }, [open]);

  useEffect(() => () => {
    generationRef.current += 1;
    const owned = takeOwned();
    revokeOnce(owned);
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
    const node = logRef.current;
    if (!node) return;
    setAwayFromLatest(node.scrollHeight - node.scrollTop - node.clientHeight > 48);
  }, [messages, open]);

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

  function placeTile(id: string, generation: number, next: PreparedFile & { preview: string }) {
    if (generationRef.current !== generation) {
      revokeOnce([next]);
      return;
    }
    const current = tilesRef.current;
    if (!current.some((item) => item.id === id)) {
      revokeOnce([next]);
      return;
    }
    const replaced = current.map((item) => item.id === id ? next : item);
    const sizes = replaced.flatMap((item) => item.status === "ready" ? [item.bytes] : []);
    if (next.status === "ready" && !withinByteCap(sizes)) {
      revokeOnce([next]);
      changeDraft(draftRef.current, current.map((item) => item.id === id
        ? { ...next, url: "", preview: "", status: "invalid" as const, bytes: 0, message: fileNotice("too-large") }
        : item));
      return;
    }
    changeDraft(draftRef.current, replaced);
  }

  async function takeFiles(list: FileList | null) {
    setAddOpen(false);
    if (!list || list.length === 0) return;
    const generation = generationRef.current;
    const room = roomFor(tilesRef.current.length);
    if (list.length > room) setLocalError(fileNotice("too-many"));
    const chosen = [...list].slice(0, room);
    const reserved: Array<PreparedFile & { preview: string }> = chosen.map((file) => ({
      id: messageId(),
      name: displayFileName(file.name || "file"),
      filename: displayFileName(file.name || "file"),
      mediaType: file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg",
      url: "",
      preview: "",
      status: "pending",
      message: null,
      bytes: 0,
    }));
    changeDraft(draftRef.current, [...tilesRef.current, ...reserved]);
    for (let index = 0; index < chosen.length; index += 1) {
      const file = chosen[index];
      const reservedTile = reserved[index];
      if (!file || !reservedTile) continue;
      const pdf = reservedTile.mediaType === "application/pdf";
      if (pdf) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await pdfPages(bytes);
        if (generationRef.current !== generation) continue;
        if ("message" in result) {
          placeTile(reservedTile.id, generation, { ...reservedTile, status: "invalid", message: result.message });
          continue;
        }
        const preview = URL.createObjectURL(file);
        const url = await dataUrl(file);
        placeTile(reservedTile.id, generation, {
          ...reservedTile, url, preview, status: "ready", bytes: bytes.byteLength, message: null,
        });
        continue;
      }
      try {
        const blob = await jpegBlob(file);
        if (generationRef.current !== generation) continue;
        const preview = URL.createObjectURL(blob);
        const url = await dataUrl(blob);
        placeTile(reservedTile.id, generation, {
          ...reservedTile,
          filename: postedPhotoName(file.name || "file"),
          url,
          preview,
          status: "ready",
          bytes: blob.size,
          message: null,
        });
      } catch {
        placeTile(reservedTile.id, generation, {
          ...reservedTile, status: "invalid", message: fileNotice("undecodable"),
        });
      }
    }
  }

  function removeTile(id: string) {
    const current = tilesRef.current;
    const tile = current.find((item) => item.id === id);
    if (tile?.preview && !ownsPreview(tile.preview)) revokeOnce([tile]);
    changeDraft(draftRef.current, current.filter((item) => item.id !== id));
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
    // A full draft has no room for speech: no recognizer, no permission prompt, no audio.
    if (!started.accepting) return;
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

  async function submit(text: string, id = messageId(), retainedText = false) {
    if (speechRef.current?.listening) {
      publishSpeech(commitInterim(speechRef.current));
      recognizerRef.current?.stop();
      return;
    }
    if (loading || busy || routeError?.terminal) return;
    const flight = inflightRef.current;
    const retrying = !retainedText && flight?.id === id;
    if (retrying && flight.generation !== generationRef.current) return;
    const currentTiles = retainedText ? [] : retrying ? flight.tiles : tilesRef.current;
    if (!retrying && currentTiles.some((tile) => tile.status === "pending" || tile.status === "invalid")) return;
    const ready = currentTiles.filter((tile) => tile.status === "ready");
    if (!withinByteCap(ready.map((tile) => tile.bytes))) {
      setLocalError(fileNotice("too-large"));
      return;
    }
    if (!sendLock.current.tryBegin()) return;
    let settled = false;
    try {
      const sentText = retrying ? flight.text : text;
      const composerFiles = tilesRef.current
        .filter((tile) => tile.status === "ready")
        .map((tile) => ({ type: "file" as const, mediaType: tile.mediaType, filename: tile.filename, url: tile.url }));
      const retainedParts = retainedText
        ? partsForRetry({ kind: "text", messageId: id, text: sentText }, composerFiles)
        : null;
      const outgoing = outgoingMessage({
        id,
        text: retainedParts?.find((part) => part.type === "text")?.text ?? sentText,
        files: retainedParts
          ? []
          : ready.map((tile) => ({ type: "file", mediaType: tile.mediaType, filename: tile.filename, url: tile.url })),
      });
      if (!outgoing.ok) {
        if (outgoing.reason === "too_long") setLocalError("Couldn't send that.");
        return;
      }
      setLocalError(null);
      const textPart = outgoing.body.message.parts.find((part) => part.type === "text");
      const sent = textPart?.type === "text" ? textPart.text : "";
      noteAcceptedSend(chat, { messageId: id, text: sent, hasFiles: ready.length > 0 && !retainedText });
      if (!retrying && !retainedText) {
        const previous = inflightRef.current;
        if (previous) {
          const sending = new Set(ready.map((tile) => tile.preview).filter(Boolean));
          revokeOnce(previous.tiles.filter((tile) => !sending.has(tile.preview)));
        }
        const record: Flight = {
          id,
          text: sent,
          tiles: ready,
          revision: revisionRef.current,
          generation: generationRef.current,
        };
        inflightRef.current = record;
        setInflight(record);
        const spoken = speechRef.current;
        if (spoken?.accepting) {
          const sealed = sealSpeech(spoken);
          speechRef.current = sealed;
          setSpeech(sealed);
        }
        draftRef.current = "";
        tilesRef.current = [];
        setDraft("");
        setTiles([]);
      }
      clearError();
      if (retainedText) {
        inflightRef.current = null;
        setInflight(null);
      }
      const exists = chat.messages.some((message) => message.role === "user" && message.id === id);
      const parts = outgoing.body.message.parts;
      if (exists) await sendMessage({ messageId: id, role: "user", parts });
      else await sendMessage({ id, role: "user", parts });
      finish(chat.status === "error" || chat.error ? "rejected" : "success");
      settled = true;
    } catch {
      if (!settled) finish("rejected");
    } finally {
      sendLock.current.end();
    }
  }

  function sendCurrent() {
    const flight = inflightRef.current;
    if (flight && flight.generation === generationRef.current && revisionRef.current === flight.revision) {
      void submit(flight.text, flight.id);
      return;
    }
    void submit(draftRef.current);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || composing.current || event.nativeEvent.isComposing) return;
    event.preventDefault();
    sendCurrent();
  }

  return (
    <div className={styles.thread} data-chunk={ASSISTANT_CHUNK} data-retry={memory.retryToken} style={{ paddingBottom: keyboardInset }}>
      <p className={styles.live} aria-live="polite" aria-atomic="true" ref={liveRef} />
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
            scanning={busy && index === lastUserIndex}
            undoState={undoState}
            disabled={!!routeError?.terminal || busy}
            turnFailed={status === "error" && message.role === "assistant" && index === messages.length - 1}
            onChoice={(text) => { void submit(text); }}
            onUndo={(card) => {
              void undoCard(card, lines, storeId, chat, undoState, onCartFailure);
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
      {messages.length === 0 && tiles.length === 0 ? (
        <p className={styles.bubble}>{`Hi, I'm ${storeName}'s AI shopping assistant. Ask about a dish or an item.`}</p>
      ) : null}
      {messages.length === 0 && tiles.length === 0 ? (
        <div className={styles.starters}>
          {STARTERS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              className={styles.chip}
              disabled={!!routeError?.terminal}
              onClick={() => {
                changeDraft(starter.text);
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
          {retry ? (
            <button
              type="button"
              className={styles.ghost}
              disabled={loading || busy || !!routeError?.terminal || !!speech?.listening}
              onClick={() => {
                if (sendLock.current.held) return;
                void submit(retry.text, retry.messageId, retry.kind === "text");
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
          sendCurrent();
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
        {speech?.interim ? <p className={styles.interim}>{speech.interim}</p> : null}
        <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(event) => { void takeFiles(event.target.files); event.target.value = ""; }} />
        <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(event) => { void takeFiles(event.target.files); event.target.value = ""; }} />
        <input ref={pdfInput} type="file" accept="application/pdf" hidden onChange={(event) => { void takeFiles(event.target.files); event.target.value = ""; }} />
        {/* One stable tree in reading order: textarea, tiles, tools. The textarea never remounts. */}
        <div className={styles.composerRow} data-files={tiles.length > 0 ? "on" : undefined}>
        <textarea
          id="assistant-composer"
          ref={composer}
          data-testid="assistant-composer"
          maxLength={2000}
          placeholder="Ask about a dish or an item"
          value={draft}
          disabled={!!routeError?.terminal}
          onChange={(event) => {
            const next = event.target.value;
            if (speechRef.current) {
              const edited = noteCustomerEdit(speechRef.current, next);
              speechRef.current = edited;
              setSpeech(edited);
            }
            changeDraft(next);
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={onKeyDown}
        />
        {tiles.length > 0 ? (
          <div className={styles.tiles}>
            {tiles.map((tile) => (
              <div
                key={tile.id}
                className={styles.tile}
                data-status={tile.status}
                aria-busy={tile.status === "pending" ? true : undefined}
              >
                {tile.status === "pending" ? (
                  <span className={styles.preparing} aria-hidden="true" />
                ) : tile.preview && tile.mediaType === "image/jpeg" ? (
                  <img src={tile.preview} alt="" />
                ) : (
                  <span className={styles.tileGlyph} aria-hidden="true"><FileText size={20} /></span>
                )}
                <div className={styles.tileText}>
                  <p className={styles.tileName}>{tile.name}</p>
                  <p>{tile.status === "pending" ? "Preparing…" : tile.mediaType === "application/pdf" ? "PDF" : "Photo"}</p>
                </div>
                <button
                  type="button"
                  className={styles.tileRemove}
                  aria-label={`Remove ${tile.name}`}
                  onClick={() => removeTile(tile.id)}
                >
                  <X size={18} aria-hidden="true" />
                </button>
                {tile.message ? <p className={styles.tileMessage}>{tile.message}</p> : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className={styles.tools}>
          <div ref={addWrap} className={styles.addWrap}>
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
            {/* Right after Add in the DOM, so focus goes Add, then the menu. It floats, so it adds no height. */}
            {addOpen ? (
              <div className={styles.addMenu}>
                <button type="button" onClick={() => cameraInput.current?.click()}>Camera</button>
                <button type="button" onClick={() => photoInput.current?.click()}>Photos</button>
                <button type="button" onClick={() => pdfInput.current?.click()}>PDF</button>
              </div>
            ) : null}
          </div>
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
            disabled={!!routeError?.terminal || busy || loading || tiles.some((tile) => tile.status !== "ready") || (!speech?.listening && draft.trim().length === 0 && !tiles.some((tile) => tile.status === "ready"))}
          >
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </div>
        </div>
        <p className={styles.note}>{FILE_NOTE}</p>
        {speech?.listening ? <p className={styles.note}>{LISTENING_NOTE}</p> : null}
      </form>
    </div>
  );
}

function searchesShelves(part: UIMessage["parts"][number]): boolean {
  if (part.type === "tool-search_catalog") return true;
  return part.type === "dynamic-tool" && part.toolName === "search_catalog";
}

/** Reads only this turn: the reply after the last customer message, never an earlier one. */
function waitingLabel(messages: UIMessage[]): string {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") { lastUser = index; break; }
  }
  const reply = messages.slice(lastUser + 1).find((message) => message.role === "assistant");
  if (reply?.parts.some(searchesShelves)) return "Checking the shelves";
  if (lastUser >= 0 && messages[lastUser]?.parts.some((part) => part.type === "file")) return "Reading your list";
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
  scanning,
  undoState,
  disabled,
  turnFailed,
  onChoice,
  onUndo,
  onChange,
  onClose,
}: {
  message: UIMessage;
  scanning: boolean;
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
        {files.map((file, index) => (
          file.mediaType.startsWith("image/") && file.url
            ? (
              <span
                key={`file-${index}`}
                className={styles.sentPhoto}
                data-scanning={scanning ? "on" : undefined}
              >
                <img src={file.url} alt="Photo you sent" />
              </span>
            )
            : (
              <p key={`file-${index}`} className={styles.fileChip}>
                {file.filename ?? (file.mediaType.startsWith("image/") ? "Photo" : "PDF")}
              </p>
            )
        ))}
        {text ? <p>{text}</p> : null}
      </div>
    );
  }
  // Every addition in this turn folds into one row, at the place of the first one.
  const partCards = message.parts.map((part) => (part.type === "text" ? [] : cardsFromParts([part], { turnFailed })));
  const turnAdded = partCards.flat().filter((card) => card.kind === "added");
  const firstAdded = partCards.findIndex((cards) => cards.some((card) => card.kind === "added"));
  return (
    <div className={styles.message}>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          return part.text ? <AssistantMarkdown key={`${message.id}-text-${index}`} className={`${styles.bubble} ${styles.reply}`} text={part.text} /> : null;
        }
        const cards = partCards[index] ?? [];
        const added = index === firstAdded ? turnAdded : [];
        if (cards.length === 0 && added.length === 0) return null;
        const products = cards.filter((card) => card.kind === "product");
        const rest = cards.filter((card) => card.kind !== "product" && card.kind !== "added");
        if (products.length === 0 && added.length === 0 && rest.length === 0) return null;
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
        {card.listingId && card.variantId ? (
          <div className={styles.cardAdd}>
            <QuickAddStepper
              item={{
                listingId: card.listingId,
                variantId: card.variantId,
                name: card.name,
                price: card.priceCents,
                imageUrl: card.imageUrl ?? undefined,
                packLabel: card.packLabel,
              }}
            />
          </div>
        ) : null}
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
  chat: ReturnType<typeof retainSession>,
  undoState: Record<string, "undone" | "already_removed">,
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
    commitUndoLabel(chat, card.additionId, label);
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
  acknowledgeUndo(chat, card.additionId, ack, refresh);
}
