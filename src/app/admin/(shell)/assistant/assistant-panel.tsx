"use client";

import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { CircleAlert, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { confirmAdminAssistantDraft, rejectAdminAssistantDraft, sendAdminAssistantMessage } from "@/lib/admin/assistant/actions";
import type { AdminDraftCard } from "@/lib/admin/assistant/drafts";
import type { AdminAssistantMessage, AssistantLink } from "@/lib/admin/assistant/types";
import { AdminDraftCardView, type DraftChoice } from "./draft-card";

/** A card with a photo goes as a form, so the photo reaches the server; the rest as plain fields. */
function confirmInput(draftId: string, { text, keep, image }: DraftChoice): FormData | Record<string, unknown> {
  if (!image) return { draftId, ...(text !== undefined ? { text } : {}), ...(keep ? { keep } : {}) };
  const form = new FormData();
  form.set("draftId", draftId);
  if (text !== undefined) form.set("text", text);
  for (const key of keep ?? []) form.append("keep", key);
  form.set("image", image);
  return form;
}

type SpeechHost = Window & {
  SpeechRecognition?: new () => BrowserSpeech;
  webkitSpeechRecognition?: new () => BrowserSpeech;
};

function plain(text: string): string {
  return text.replaceAll("**", "").replaceAll("`", "");
}

/**
 * The store copilot's chat, for a platform admin. Voice is the browser's own speech recognition: the words land in
 * the box to read and edit, and nothing is sent, audio or text, until Send is tapped.
 */
export function AdminAssistantPanel({
  conversationId: initialConversationId,
  messages: initialMessages,
  drafts: initialDrafts,
}: {
  conversationId: string | null;
  messages: AdminAssistantMessage[];
  drafts: Record<string, AdminDraftCard[]>;
}) {
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [messages, setMessages] = useState(initialMessages);
  const [drafts, setDrafts] = useState(initialDrafts);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [speech, setSpeech] = useState<SpeechState | null>(null);
  const [pending, startTransition] = useTransition();
  const speechRef = useRef<SpeechState | null>(null);
  const recognizerRef = useRef<BrowserSpeech | null>(null);
  const listening = speech?.listening ?? false;
  const trimmed = text.trim();

  const canListen = useSyncExternalStore(
    () => () => {},
    () => Boolean((window as SpeechHost).SpeechRecognition ?? (window as SpeechHost).webkitSpeechRecognition),
    () => false,
  );

  function publish(next: SpeechState) {
    speechRef.current = next;
    setSpeech(next);
    setText(next.draft);
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
    const started = beginSpeech(text, (speechRef.current?.session ?? 0) + 1);
    publish(started);
    if (!started.accepting) return;
    const recognizer = new Ctor();
    recognizerRef.current = recognizer;
    try {
      bindRecognizer(recognizer, {
        lang: recognitionLanguage(document.documentElement.lang, navigator.language),
        session: started.session,
        read: () => speechRef.current ?? started,
        write: publish,
      });
    } catch {
      publish(stopSpeech(started));
      setNotice("Microphone access is off. You can type instead.");
    }
  }

  function send() {
    if (speechRef.current) {
      recognizerRef.current?.stop();
      speechRef.current = sealSpeech(speechRef.current);
      setSpeech(speechRef.current);
    }
    const draft = text;
    const messageId = crypto.randomUUID();
    startTransition(async () => {
      const result = await sendAdminAssistantMessage({ conversationId: conversationId ?? undefined, messageId, text: draft });
      if (!result.ok) {
        setNotice(result.message);
        return;
      }
      setNotice(null);
      setText("");
      speechRef.current = null;
      setSpeech(null);
      setConversationId(result.conversationId);
      if (result.drafts.length > 0) setDrafts((current) => ({ ...current, [messageId]: result.drafts }));
      setMessages((current) => [
        ...current,
        { role: "admin", text: draft.trim() },
        { role: "assistant", text: result.reply, messageId, links: result.links },
      ]);
    });
  }

  function replaceCard(card: AdminDraftCard) {
    setDrafts((current) => Object.fromEntries(Object.entries(current).map(([key, cards]) => [key, cards.map((item) => (item.id === card.id ? card : item))])));
  }

  function decide(card: AdminDraftCard, confirm: boolean, choice: DraftChoice = {}) {
    startTransition(async () => {
      const result = confirm
        ? await confirmAdminAssistantDraft(confirmInput(card.id, choice))
        : await rejectAdminAssistantDraft({ draftId: card.id });
      if (result.ok) {
        setNotice(null);
        replaceCard(result.draft);
        return;
      }
      setNotice(result.message);
      if (result.code === "stale" || result.code === "expired") replaceCard({ ...card, state: result.code });
      if (result.code === "refused" || result.code === "not_found") replaceCard({ ...card, state: "rejected" });
    });
  }

  return (
    <section aria-labelledby="assistant-chat-heading" className="mt-6 flex flex-col gap-6">
      <div className="flex min-h-11 flex-wrap items-end justify-between gap-3">
        <h2 id="assistant-chat-heading" className="text-lg font-semibold text-foreground">Chat</h2>
        <Button
          type="button"
          variant="outline"
          disabled={pending || messages.length === 0}
          className="min-h-11 rounded-full px-4"
          onClick={() => {
            setConversationId(null);
            setMessages([]);
            setDrafts({});
            setNotice(null);
          }}
        >
          New chat
        </Button>
      </div>

      {messages.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-5 text-base text-muted-foreground">
          Try “Which stores are stuck in onboarding?” or “Which refunds failed?”
        </p>
      ) : (
        <section aria-label="Conversation" className="flex flex-col gap-3">
          {messages.map((message, index) => (
            <div key={`${message.role}-${index}`} className="flex flex-col gap-3">
              <p
                className={message.role === "admin"
                  ? "max-w-[65ch] whitespace-pre-wrap rounded-xl bg-muted px-4 py-3 text-base leading-6 text-foreground"
                  : "max-w-[65ch] whitespace-pre-wrap text-base leading-6 text-foreground"}
              >
                <span className="mb-1 block text-[0.8125rem] font-semibold">{message.role === "admin" ? "You" : "Assistant"}</span>
                {plain(message.text)}
              </p>
              {message.links?.length ? <LinkList links={message.links} /> : null}
              {message.role === "assistant" && message.messageId
                ? drafts[message.messageId]?.map((card) => (
                  <AdminDraftCardView
                    key={`${card.id}-${card.state}`}
                    card={card}
                    disabled={pending}
                    onConfirm={(choice) => decide(card, true, choice)}
                    onDismiss={() => decide(card, false)}
                  />
                ))
                : null}
            </div>
          ))}
        </section>
      )}

      <form
        className="-mx-4 border-t border-border bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:mx-0 sm:px-0"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && !listening && trimmed) send();
        }}
      >
        {notice ? (
          <p className="mb-3 flex items-start gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </p>
        ) : null}
        <label htmlFor="admin-assistant-message" className="text-[0.8125rem] font-semibold text-foreground">
          Message
        </label>
        <textarea
          id="admin-assistant-message"
          name="message"
          value={text}
          maxLength={1000}
          rows={2}
          disabled={pending}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            if (speechRef.current) publish(noteCustomerEdit(speechRef.current, event.target.value));
          }}
          placeholder="Which stores are stuck in onboarding?"
          className="mt-2 min-h-16 w-full resize-none rounded-xl border border-border bg-card px-3 py-3 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[0.8125rem] text-muted-foreground tabular-nums" aria-live="polite">
            {listening ? "Listening. Tap Stop, check the words, then Send." : text.length > 0 ? `${text.length} / 1000` : "Up to 1,000 characters"}
          </p>
          <div className="flex gap-2">
            {canListen ? (
              <Button type="button" variant="outline" onClick={toggleRecord} disabled={pending} className="min-h-12 rounded-full px-5">
                {listening ? <Square className="size-4" aria-hidden="true" /> : <Mic className="size-4" aria-hidden="true" />}
                {listening ? "Stop" : "Speak"}
              </Button>
            ) : null}
            <Button type="submit" disabled={pending || listening || trimmed.length === 0} className="min-h-12 rounded-full px-6">
              {pending ? "Sending" : "Send"}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

/** The screens a reply drew on, each a link built from the tool results. */
function LinkList({ links }: { links: AssistantLink[] }) {
  return (
    <section aria-label="Open in admin" className="max-w-[65ch] rounded-xl border border-border bg-card px-4 py-2">
      <ul className="flex flex-col divide-y divide-border">
        {links.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="flex min-h-11 items-center py-2 text-base font-semibold text-foreground underline-offset-4 hover:underline focus-visible:underline"
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
