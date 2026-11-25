"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { AssistantDock } from "@/components/assistant-dock/assistant-dock";
import { AssistantTurn, Composer, Conversation, DockThread, EmptyIntro, Starters, UserTurn, Working, dockStyles } from "@/components/assistant-dock/chat";
import {
  confirmAdminAssistantDraft,
  loadAdminAssistant,
  rejectAdminAssistantDraft,
  sendAdminAssistantMessage,
} from "@/lib/admin/assistant/actions";
import { briefingSummary, type AdminBriefing } from "@/lib/admin/assistant/briefing-view";
import type { AdminDraftCard } from "@/lib/admin/assistant/drafts";
import type { AdminAssistantMessage, AssistantLink } from "@/lib/admin/assistant/types";
import { AdminDraftCardView, type DraftChoice } from "./draft-card";

const STARTERS = [
  "Which stores are stuck in onboarding?",
  "Which refunds failed?",
  "Which applications are waiting?",
  "Which couriers had incidents this week?",
] as const;

const LOAD_FAILED = "The assistant couldn't load. Close it and open it again.";

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

/**
 * The platform admin assistant (#831–#834) as the floating button and chat sheet on every /admin page (#855).
 * The chat loads on first open; nothing changes until the admin confirms a card.
 */
export function AdminAssistantDock() {
  const [loaded, setLoaded] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AdminAssistantMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AdminDraftCard[]>>({});
  const [briefing, setBriefing] = useState<AdminBriefing | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [pending, startTransition] = useTransition();

  function load() {
    startTransition(async () => {
      try {
        const chat = await loadAdminAssistant();
        setConversationId(chat.conversationId);
        setMessages(chat.messages);
        setDrafts(chat.drafts);
        setBriefing(chat.briefing);
        setLoaded(true);
      } catch {
        setNotice(LOAD_FAILED);
      }
    });
  }

  /** Sends the box's text, or a starter or briefing question when one is tapped. */
  function send(fixed?: string) {
    const draft = (fixed ?? text).trim();
    if (!draft) return;
    const messageId = crypto.randomUUID();
    if (fixed === undefined) setText("");
    setSending(draft);
    startTransition(async () => {
      const result = await sendAdminAssistantMessage({ conversationId: conversationId ?? undefined, messageId, text: draft });
      setSending(null);
      if (!result.ok) {
        setNotice(result.message);
        if (fixed === undefined) setText((current) => current || draft);
        return;
      }
      setNotice(null);
      setAnnounce(result.reply);
      setConversationId(result.conversationId);
      if (result.drafts.length > 0) setDrafts((current) => ({ ...current, [messageId]: result.drafts }));
      setMessages((current) => [
        ...current,
        { role: "admin", text: draft },
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

  const empty = messages.length === 0 && !sending;

  return (
    <AssistantDock
      title="Assistant"
      hideKey="platform-admin"
      menu={[{ href: "/admin/assistant/activity", label: "Assistant activity" }]}
      newChat={{
        disabled: pending || messages.length === 0,
        onClick: () => {
          setConversationId(null);
          setMessages([]);
          setDrafts({});
          setNotice(null);
        },
      }}
      onFirstOpen={load}
    >
      <DockThread
        follow={`${messages.length}:${Object.values(drafts).flat().map((card) => card.state).join()}`}
        working={sending !== null}
        announce={announce}
        foot={
          <Composer
            id="admin-assistant-message"
            value={text}
            onChange={setText}
            onSend={() => send()}
            busy={pending || !loaded}
            placeholder="Ask about stores, orders, refunds or the catalogue…"
            notice={notice}
            onNotice={setNotice}
          />
        }
      >
        {!loaded ? (
          notice ? null : <Working label="Loading" />
        ) : empty ? (
          <EmptyIntro
            heading="Today"
            lead={briefing && briefing.items.length === 0 && briefing.unread.length > 0
              ? "Part of today's list could not be read. Ask the assistant instead."
              : briefingSummary(briefing?.items ?? [])}
          >
            {briefing ? <Briefing briefing={briefing} disabled={pending} onAsk={send} /> : null}
            <Starters items={STARTERS} disabled={pending} onPick={send} />
          </EmptyIntro>
        ) : (
          <Conversation working={sending !== null}>
            {messages.map((message, index) =>
              message.role === "admin" ? (
                <UserTurn key={index} text={message.text} />
              ) : (
                <AssistantTurn key={index} text={message.text}>
                  {message.links?.length ? <LinkList links={message.links} /> : null}
                  {message.messageId
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
                </AssistantTurn>
              ),
            )}
            {sending ? <UserTurn text={sending} /> : null}
            {sending ? <Working /> : null}
          </Conversation>
        )}
      </DockThread>
    </AssistantDock>
  );
}

/** What needs an admin today (#834), as compact cards: each opens its screen behind the sheet, or asks its question. */
function Briefing({ briefing, disabled, onAsk }: { briefing: AdminBriefing; disabled: boolean; onAsk: (ask: string) => void }) {
  if (briefing.items.length === 0) return null;
  return (
    <ul className={dockStyles.brief} aria-label="Needs an admin today">
      {briefing.items.map((item) => (
        <li key={item.key} className={dockStyles.briefCard}>
          <div>
            <Link href={item.href}>{item.label}{item.incomplete ? " or more" : ""}</Link>
            {item.names.length > 0 ? <p>{item.names.join(", ")}</p> : null}
          </div>
          <button type="button" className={dockStyles.chip} disabled={disabled} onClick={() => onAsk(item.ask)}>
            Ask the assistant
          </button>
        </li>
      ))}
      {briefing.unread.length > 0 ? <li className={dockStyles.lead}>Part of today&rsquo;s list could not be read.</li> : null}
    </ul>
  );
}

/** The screens a reply drew on, each a link built from the tool results. They open behind the sheet. */
function LinkList({ links }: { links: AssistantLink[] }) {
  return (
    <ul className={dockStyles.brief} aria-label="Open in admin">
      {links.map((item) => (
        <li key={item.href} className={dockStyles.briefCard}>
          <Link href={item.href}>{item.label}</Link>
        </li>
      ))}
    </ul>
  );
}
