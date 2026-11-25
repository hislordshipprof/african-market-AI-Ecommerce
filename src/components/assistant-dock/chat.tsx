"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUp, CircleAlert, Mic, Square } from "lucide-react";
import { composerKeySends, nearLatest } from "@/lib/assistant/ui/dock";
import { parseMarkdown, type Inline } from "@/lib/assistant/ui/markdown";
import {
  beginSpeech,
  bindRecognizer,
  noteCustomerEdit,
  recognitionLanguage,
  sealSpeech,
  stopSpeech,
  type BrowserSpeech,
  type SpeechState,
} from "@/lib/assistant/ui/speech";
import styles from "./dock.module.css";

/**
 * The thread: a log that follows the newest message unless the reader scrolled up, then the pinned composer.
 * `follow` changes whenever a message or card is added.
 */
export function DockThread({
  follow,
  working,
  announce,
  children,
  foot,
}: {
  follow: unknown;
  working: boolean;
  /** The newest reply, read out once it arrives. */
  announce: string;
  children: ReactNode;
  foot: ReactNode;
}) {
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);

  useLayoutEffect(() => {
    const node = log.current;
    if (!node) return;
    // Sending always brings the newest turn into view; a reply only follows a reader who is still at the bottom.
    if (stick.current || working) {
      node.scrollTop = node.scrollHeight;
      stick.current = true;
      setAway(false);
    }
  }, [follow, working]);

  return (
    <>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{working ? "" : announce}</p>
      <div
        ref={log}
        className={styles.log}
        onScroll={(event) => {
          const latest = nearLatest(event.currentTarget);
          stick.current = latest;
          setAway(!latest);
        }}
      >
        <div className={styles.column}>{children}</div>
      </div>
      <div className={styles.foot}>
        {away ? (
          <button
            type="button"
            className={styles.jump}
            onClick={() => {
              const node = log.current;
              if (!node) return;
              node.scrollTo({ top: node.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
            }}
          >
            Jump to latest
          </button>
        ) : null}
        {foot}
      </div>
    </>
  );
}

export function Conversation({ working, children }: { working: boolean; children: ReactNode }) {
  return (
    <section aria-label="Conversation" aria-busy={working} className={styles.column}>
      {children}
    </section>
  );
}

export function UserTurn({ text }: { text: string }) {
  return <p className={styles.user}>{text}</p>;
}

/** An assistant turn: rendered markdown and the cards that came with it, no role label. */
export function AssistantTurn({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className={styles.turn}>
      <DockMarkdown text={text} />
      {children}
    </div>
  );
}

export function Working({ label = "Working" }: { label?: string }) {
  return (
    <p className={styles.working} role="status">
      <span className={styles.dots} aria-hidden="true"><span /><span /><span /></span>
      {label}
    </p>
  );
}

export function Starters({ items, disabled, onPick }: { items: readonly string[]; disabled: boolean; onPick: (text: string) => void }) {
  return (
    <div className={styles.starters} role="group" aria-label="Try asking">
      {items.map((item) => (
        <button key={item} type="button" className={styles.chip} disabled={disabled} onClick={() => onPick(item)}>
          {item}
        </button>
      ))}
    </div>
  );
}

export function EmptyIntro({ heading, lead, children }: { heading: string; lead: string; children: ReactNode }) {
  return (
    <section aria-label={heading} className={styles.empty}>
      <div>
        <h3>{heading}</h3>
        <p className={styles.lead}>{lead}</p>
      </div>
      {children}
    </section>
  );
}

export const dockStyles = styles;

function renderInline(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.text;
    if (node.type === "strong") return <strong key={index}>{renderInline(node.children)}</strong>;
    if (node.type === "em") return <em key={index}>{renderInline(node.children)}</em>;
    // A same-site link moves the page behind the sheet, which stays open; linkTarget() checked both kinds.
    return node.external ? (
      <a key={index} href={node.href} target="_blank" rel="noopener noreferrer">{renderInline(node.children)}</a>
    ) : (
      <Link key={index} href={node.href}>{renderInline(node.children)}</Link>
    );
  });
}

/** The reply as text, bold, italics, lists and safe links. Never raw HTML. */
export function DockMarkdown({ text }: { text: string }) {
  return (
    <div className={styles.reply}>
      {parseMarkdown(text).map((block, index) =>
        block.type === "paragraph" ? (
          <p key={index}>{renderInline(block.children)}</p>
        ) : block.ordered ? (
          <ol key={index}>{block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)}</ol>
        ) : (
          <ul key={index}>{block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)}</ul>
        ),
      )}
    </div>
  );
}

type SpeechHost = Window & {
  SpeechRecognition?: new () => BrowserSpeech;
  webkitSpeechRecognition?: new () => BrowserSpeech;
};

/**
 * The pinned composer: a textarea that grows with its text, voice and send. Enter sends, Shift+Enter adds a line.
 * Voice is the browser's own speech recognition: the words land in the box to read and edit, and nothing is sent
 * until Send.
 */
export function Composer({
  id,
  value,
  onChange,
  onSend,
  busy,
  placeholder,
  notice,
  onNotice,
}: {
  id: string;
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  busy: boolean;
  placeholder: string;
  notice: string | null;
  onNotice: (text: string) => void;
}) {
  const [speech, setSpeech] = useState<SpeechState | null>(null);
  const speechRef = useRef<SpeechState | null>(null);
  const recognizerRef = useRef<BrowserSpeech | null>(null);
  const composing = useRef(false);
  const listening = speech?.listening ?? false;
  const canListen = useSyncExternalStore(
    () => () => {},
    () => Boolean((window as SpeechHost).SpeechRecognition ?? (window as SpeechHost).webkitSpeechRecognition),
    () => false,
  );
  const ready = !busy && !listening && value.trim().length > 0;

  function publish(next: SpeechState | null) {
    speechRef.current = next;
    setSpeech(next);
    if (next) onChange(next.draft);
  }

  function toggleRecord() {
    if (speechRef.current?.listening) {
      recognizerRef.current?.stop();
      publish(stopSpeech(speechRef.current));
      return;
    }
    const host = window as SpeechHost;
    const Ctor = host.SpeechRecognition ?? host.webkitSpeechRecognition;
    if (!Ctor) return;
    const started = beginSpeech(value, (speechRef.current?.session ?? 0) + 1);
    publish(started);
    if (!started.accepting) return;
    const recognizer = new Ctor();
    recognizerRef.current = recognizer;
    try {
      bindRecognizer(recognizer, {
        lang: recognitionLanguage(document.documentElement.lang, navigator.language),
        session: started.session,
        read: () => speechRef.current ?? started,
        write: (next) => publish(next),
      });
    } catch {
      publish(stopSpeech(started));
      onNotice("Microphone access is off. You can type instead.");
    }
  }

  function send() {
    if (!ready) return;
    if (speechRef.current) {
      recognizerRef.current?.stop();
      sealSpeech(speechRef.current);
      speechRef.current = null;
      setSpeech(null);
    }
    onSend();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {notice ? (
        <p className={styles.notice} role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </p>
      ) : null}
      <div className={styles.composer}>
        <label htmlFor={id} className="sr-only">Message</label>
        <textarea
          id={id}
          name="message"
          value={value}
          maxLength={1000}
          rows={1}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
            if (speechRef.current) {
              const edited = noteCustomerEdit(speechRef.current, event.target.value);
              speechRef.current = edited;
              setSpeech(edited);
            }
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (!composerKeySends({ key: event.key, shiftKey: event.shiftKey, isComposing: composing.current || event.nativeEvent.isComposing })) return;
            event.preventDefault();
            send();
          }}
        />
        <div className={styles.tools}>
          {canListen ? (
            <button
              type="button"
              className={styles.tool}
              aria-pressed={listening}
              aria-label={listening ? "Stop listening" : "Speak"}
              disabled={busy}
              onClick={toggleRecord}
            >
              {listening ? <Square size={16} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
            </button>
          ) : null}
          <button type="submit" className={styles.send} aria-label="Send" disabled={!ready}>
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      <p className={styles.hint} aria-live="polite">
        {listening ? "Listening. Tap Stop, check the words, then send." : "Enter sends. Shift+Enter adds a line. Nothing changes until you confirm a card."}
      </p>
    </form>
  );
}
