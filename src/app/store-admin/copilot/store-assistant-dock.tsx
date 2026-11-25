"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { AssistantDock } from "@/components/assistant-dock/assistant-dock";
import { AssistantTurn, Composer, Conversation, DockThread, EmptyIntro, Starters, UserTurn, Working, dockStyles } from "@/components/assistant-dock/chat";
import { Button } from "@/components/ui/button";
import { PlanLocked } from "@/components/store-admin/plan-locked";
import {
  chooseProposalListing,
  confirmCopilotDraft,
  confirmStockProposal,
  loadStoreAssistant,
  rejectCopilotDraft,
  rejectStockProposal,
  sendCopilotMessage,
} from "@/lib/copilot/actions";
import type { AlertView } from "@/lib/copilot/alerts";
import type { ChoiceCard, CouponFields, DraftCard, ListingFix, PanelMessage, StockProposalCard } from "@/lib/copilot/types";
import { DraftCardView } from "./draft-card";

const STARTERS = [
  "Got 20 bags of gari",
  "How did sales go this week?",
  "Which listings need fixing?",
  "What should I reorder?",
] as const;

const LOAD_FAILED = "The assistant couldn't load. Close it and open it again.";

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

function choiceChange(choice: ChoiceCard): string {
  if (choice.kind === "set_status") return `Mark ${(choice.statusValue ?? "updated").replaceAll("_", " ")}`;
  if (choice.kind === "restock") return `Add ${choice.quantity ?? 0}`;
  if (choice.kind === "counter_sale") return `Counter sale of ${choice.quantity ?? 0}`;
  return `Recount to ${choice.quantity ?? 0}`;
}

function stateLine(state: StockProposalCard["state"]): string {
  if (state === "confirmed") return "On the shelf";
  if (state === "rejected") return "Dismissed";
  if (state === "expired") return "Expired. Send it again.";
  return "Waiting for you";
}

function confirmLabel(card: StockProposalCard): string {
  if (card.kind === "set_status") return `Mark ${(card.afterStatus ?? "updated").replaceAll("_", " ")}`;
  return `Put ${card.afterQty ?? 0} on the shelf`;
}

const HIDDEN_PATHS = ["/store-admin/sign-in", "/store-admin/two-factor"];

/**
 * The store assistant (the stock copilot's chat, #818–#820) as the floating button and chat sheet on every
 * /store-admin page (#855). Stock changes and drafts wait as cards; nothing changes until the owner confirms.
 */
export function StoreAssistantDock({ storeId, lockedTitle }: { storeId: string; lockedTitle: string }) {
  const [loaded, setLoaded] = useState(false);
  const [storeSlug, setStoreSlug] = useState("");
  const [chatAllowed, setChatAllowed] = useState(true);
  const [alerts, setAlerts] = useState<AlertView[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [proposals, setProposals] = useState<StockProposalCard[]>([]);
  const [drafts, setDrafts] = useState<DraftCard[]>([]);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [busy, setBusy] = useState<null | { kind: "confirm" | "dismiss"; id: string } | { kind: "choose"; key: string }>(null);
  const [pending, startTransition] = useTransition();
  const waiting = proposals.filter((card) => card.state === "pending");
  const settled = proposals.filter((card) => card.state !== "pending");
  const waitingDrafts = drafts.filter((card) => card.state === "pending");
  const settledDrafts = drafts.filter((card) => card.state !== "pending");

  function load() {
    startTransition(async () => {
      try {
        const panel = await loadStoreAssistant();
        setConversationId(panel.conversationId);
        setMessages(panel.messages);
        setProposals(panel.proposals);
        setDrafts(panel.drafts);
        setAlerts(panel.alerts);
        setChatAllowed(panel.chatAllowed);
        setStoreSlug(panel.storeSlug);
        setLoaded(true);
      } catch {
        setNotice(LOAD_FAILED);
      }
    });
  }

  function send(fixed?: string) {
    const draft = (fixed ?? text).trim();
    if (!draft) return;
    const messageId = crypto.randomUUID();
    if (fixed === undefined) setText("");
    setSending(draft);
    startTransition(async () => {
      const result = await sendCopilotMessage({ conversationId: conversationId ?? undefined, messageId, text: draft });
      setSending(null);
      if (!result.ok) {
        setNotice(result.message);
        if (fixed === undefined) setText((current) => current || draft);
        return;
      }
      setNotice(null);
      setAnnounce(result.reply);
      setConversationId(result.conversationId);
      setMessages((current) => [
        ...current,
        { role: "owner", text: draft },
        { role: "assistant", text: result.reply, messageId, choices: result.choices, fixes: result.fixes },
      ]);
      setProposals((current) => [...result.proposals, ...current]);
      setDrafts((current) => [...result.drafts, ...current]);
    });
  }

  function updateChoice(messageId: string, listingId: string, change: Partial<ChoiceCard>) {
    setMessages((current) => current.map((message) => (
      message.messageId !== messageId || !message.choices
        ? message
        : {
          ...message,
          choices: message.choices.map((choice) => (
            choice.candidates.some((candidate) => candidate.listingId === listingId) ? { ...choice, ...change } : choice
          )),
        }
    )));
  }

  function choose(messageId: string, listingId: string) {
    if (!conversationId) return;
    setBusy({ kind: "choose", key: `${messageId}:${listingId}` });
    startTransition(async () => {
      const result = await chooseProposalListing({ conversationId, messageId, listingId });
      setBusy(null);
      if (!result.ok) {
        setNotice(result.code === "expired"
          ? "That choice expired. Send the report again."
          : result.code === "stale"
            ? "That item changed since you asked. Send the report again."
            : "That choice is no longer open.");
        updateChoice(messageId, listingId, { open: false });
        return;
      }
      setNotice(null);
      updateChoice(messageId, listingId, { open: false, chosenListingId: listingId });
      setProposals((current) => (
        current.some((card) => card.id === result.proposal.id) ? current : [result.proposal, ...current]
      ));
    });
  }

  function decide(proposalId: string, action: "confirm" | "dismiss") {
    setBusy({ kind: action, id: proposalId });
    startTransition(async () => {
      if (action === "dismiss") {
        const result = await rejectStockProposal({ proposalId });
        setBusy(null);
        if (result.ok) {
          setNotice(null);
          setProposals((current) => current.map((card) => (card.id === proposalId ? { ...card, state: "rejected" } : card)));
        } else {
          setNotice("That change is no longer waiting. Refresh the page if it already moved.");
        }
        return;
      }
      const result = await confirmStockProposal({ proposalId });
      setBusy(null);
      if (!result.ok) {
        setNotice(result.code === "too_large"
          ? "That number is too large for this item."
          : result.code === "expired"
            ? "That change expired. Send it again."
            : "That change is no longer waiting.");
        if (result.code === "expired" || result.code === "stale") {
          setProposals((current) => current.map((card) => (card.id === proposalId ? { ...card, state: "expired" } : card)));
        }
        return;
      }
      setNotice(null);
      setProposals((current) => current.map((card) => (card.id === proposalId ? result.proposal : card)));
    });
  }

  function decideDraft(draftId: string, action: "confirm" | "dismiss", edits: { coupon?: CouponFields; variantIds?: string[]; description?: string } = {}) {
    setBusy({ kind: action, id: draftId });
    startTransition(async () => {
      if (action === "dismiss") {
        const result = await rejectCopilotDraft({ draftId });
        setBusy(null);
        if (result.ok) {
          setNotice(null);
          setDrafts((current) => current.map((card) => (card.id === draftId ? { ...card, state: "rejected" } : card)));
        } else {
          setNotice("That draft is no longer waiting. Refresh the page if it already moved.");
        }
        return;
      }
      const result = await confirmCopilotDraft({ draftId, ...edits });
      setBusy(null);
      if (!result.ok) {
        setNotice(result.message);
        if (result.code === "expired" || result.code === "stale") {
          setDrafts((current) => current.map((card) => (card.id === draftId ? { ...card, state: "expired" } : card)));
        }
        return;
      }
      setNotice(null);
      setDrafts((current) => current.map((card) => (card.id === draftId ? result.draft : card)));
    });
  }

  const empty = messages.length === 0 && proposals.length === 0 && drafts.length === 0 && !sending;
  const follow = `${messages.length}:${proposals.map((card) => card.state).join()}:${drafts.map((card) => card.state).join()}`;

  return (
    <AssistantDock
      title="Store assistant"
      hideKey={`store-admin:${storeId}`}
      hiddenOn={(pathname) => HIDDEN_PATHS.some((path) => pathname.startsWith(path))}
      menu={storeSlug ? [{ href: `/store-admin/copilot?store=${storeSlug}`, label: "Stock alerts, reports and reorder" }] : []}
      newChat={{
        disabled: pending || !chatAllowed || messages.length === 0,
        onClick: () => {
          setConversationId(null);
          setMessages([]);
          setNotice(null);
          setProposals((current) => current.filter((card) => card.state === "pending"));
          setDrafts((current) => current.filter((card) => card.state === "pending"));
        },
      }}
      onFirstOpen={load}
    >
      <DockThread
        follow={follow}
        working={sending !== null}
        announce={announce}
        foot={chatAllowed ? (
          <Composer
            id="copilot-report"
            value={text}
            onChange={setText}
            onSend={() => send()}
            busy={pending || !loaded}
            placeholder="Got 20 bags of gari…"
            notice={notice}
            onNotice={setNotice}
          />
        ) : (
          <>
            {notice ? <p className={dockStyles.notice} role="alert">{notice}</p> : null}
            <PlanLocked
              title={lockedTitle}
              description="Ask how sales went this week or what sold most, and tell it what came in or sold at the counter. It answers from your own orders, lists the listings that need fixing, and drafts stock changes, coupons, price changes, one-day hours or delivery changes and product descriptions for you to confirm. Your past chats stay here to read."
              storeSlug={storeSlug}
            />
          </>
        )}
      >
        {!loaded ? (
          notice ? null : <Working label="Loading" />
        ) : (
          <>
            {empty ? (
              <EmptyIntro
                heading={alerts.length > 0 ? "Stock alerts" : "Ask about your store"}
                lead={alerts.length > 0
                  ? `${alerts.length === 1 ? "1 item needs" : `${alerts.length} items need`} a look. Answer alerts on the copilot page.`
                  : "Say what came in, what you sold at the counter, or what you counted, or ask how sales went. Nothing changes until you tap Confirm."}
              >
                {alerts.length > 0 ? <AlertCards alerts={alerts} storeSlug={storeSlug} /> : null}
                {chatAllowed ? <Starters items={STARTERS} disabled={pending} onPick={send} /> : null}
              </EmptyIntro>
            ) : null}
            {settled.length > 0 ? (
              <section aria-label="Settled changes" className={dockStyles.brief}>
                {settled.map((card) => (
                  <ProposalCard key={card.id} card={card} />
                ))}
              </section>
            ) : null}
            {settledDrafts.length > 0 ? (
              <section aria-label="Settled drafts" className={dockStyles.brief}>
                {settledDrafts.map((card) => (
                  <DraftCardView key={card.id} card={card} disabled writing={false} onConfirm={() => {}} onDismiss={() => {}} />
                ))}
              </section>
            ) : null}
            {messages.length > 0 || sending ? (
              <Conversation working={sending !== null}>
                {messages.map((message, index) =>
                  message.role === "owner" ? (
                    <UserTurn key={index} text={message.text} />
                  ) : (
                    <AssistantTurn key={index} text={message.text}>
                      {message.fixes?.length ? <FixList fixes={message.fixes} /> : null}
                      {message.messageId && message.choices?.map((choice) => (
                        <ChoiceView
                          key={choice.candidates.map((candidate) => candidate.listingId).join(":")}
                          choice={choice}
                          messageId={message.messageId!}
                          disabled={pending}
                          busyKey={busy?.kind === "choose" ? busy.key : null}
                          onChoose={choose}
                        />
                      ))}
                    </AssistantTurn>
                  ),
                )}
                {sending ? <UserTurn text={sending} /> : null}
                {sending ? <Working /> : null}
              </Conversation>
            ) : null}
            {waitingDrafts.length > 0 ? (
              <section className={dockStyles.brief} aria-label="Drafts waiting for you">
                {waitingDrafts.map((card) => (
                  <DraftCardView
                    key={card.id}
                    card={card}
                    disabled={pending}
                    writing={busy?.kind === "confirm" && busy.id === card.id}
                    onConfirm={(edits) => decideDraft(card.id, "confirm", edits)}
                    onDismiss={() => decideDraft(card.id, "dismiss")}
                  />
                ))}
              </section>
            ) : null}
            {waiting.length > 0 ? (
              <section className={dockStyles.brief} aria-label="Waiting for you">
                {waiting.map((card) => (
                  <ProposalCard
                    key={card.id}
                    card={card}
                    writing={busy?.kind === "confirm" && busy.id === card.id}
                    disabled={pending}
                    onDecide={(action) => decide(card.id, action)}
                  />
                ))}
              </section>
            ) : null}
          </>
        )}
      </DockThread>
    </AssistantDock>
  );
}

function ProposalCard({
  card,
  writing = false,
  disabled = true,
  onDecide,
}: {
  card: StockProposalCard;
  writing?: boolean;
  disabled?: boolean;
  onDecide?: (action: "confirm" | "dismiss") => void;
}) {
  return (
    <article className="rounded-xl border border-border bg-card px-4 py-4">
      <h3 className="font-display text-xl leading-tight font-bold text-foreground">{card.listingName}</h3>
      <p className="mt-2 font-display text-[1.75rem] leading-none font-bold tracking-tight text-foreground tabular-nums">{shelfLine(card)}</p>
      <p className="mt-2 text-sm text-muted-foreground">{KIND[card.kind]} · {writing ? "Writing the shelf…" : stateLine(card.state)}</p>
      {onDecide ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" disabled={disabled} className="min-h-12 rounded-full px-6" onClick={() => onDecide("confirm")}>
            {confirmLabel(card)}
          </Button>
          <Button type="button" variant="outline" disabled={disabled} className="min-h-12 rounded-full px-6" onClick={() => onDecide("dismiss")}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function ChoiceView({
  choice,
  messageId,
  disabled,
  busyKey,
  onChoose,
}: {
  choice: ChoiceCard;
  messageId: string;
  disabled: boolean;
  busyKey: string | null;
  onChoose: (messageId: string, listingId: string) => void;
}) {
  const chosen = choice.candidates.find((candidate) => candidate.listingId === choice.chosenListingId);
  return (
    <section aria-label={choice.nearOnly ? "Did you mean" : "Which one"} className="rounded-xl border border-border bg-card px-4 py-4">
      <h3 className="font-display text-xl leading-tight font-bold text-foreground">{choice.nearOnly ? "Did you mean?" : "Which one?"}</h3>
      <p className="mt-1 text-sm text-muted-foreground tabular-nums">{choiceChange(choice)}</p>
      {chosen ? (
        <p className="mt-3 text-sm text-foreground">You picked {chosen.name}. Confirm it below.</p>
      ) : choice.open ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {choice.candidates.map((candidate) => (
            <Button
              key={candidate.listingId}
              type="button"
              variant="outline"
              disabled={disabled}
              className="min-h-11 justify-start rounded-full px-5 text-left whitespace-normal"
              onClick={() => onChoose(messageId, candidate.listingId)}
            >
              {busyKey === `${messageId}:${candidate.listingId}` ? "Drafting…" : candidate.name}
            </Button>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">This choice is closed. Send the report again.</p>
      )}
    </section>
  );
}

/** The store's open stock alerts as compact cards on an empty chat; they are answered on the copilot page. */
function AlertCards({ alerts, storeSlug }: { alerts: AlertView[]; storeSlug: string }) {
  return (
    <ul className={dockStyles.brief} aria-label="Open stock alerts">
      {alerts.slice(0, 3).map((alert) => (
        <li key={alert.id} className={dockStyles.briefCard}>
          <div>
            <p>{alert.text}</p>
          </div>
        </li>
      ))}
      <li>
        <Link href={`/store-admin/copilot?store=${storeSlug}`} className="text-sm font-semibold text-foreground underline underline-offset-4">
          Answer {alerts.length === 1 ? "it" : `all ${alerts.length}`} on the copilot page
        </Link>
      </li>
    </ul>
  );
}

const GAP_LABELS: Record<ListingFix["missing"][number], string> = {
  photo: "photo",
  aisle: "aisle",
  description: "description",
  allergens: "allergens",
};

/** The listings a "what needs fixing" reply named (#820), each a link to its form, behind the sheet. */
function FixList({ fixes }: { fixes: ListingFix[] }) {
  return (
    <section aria-label="Listings to fix">
      <ul className={dockStyles.brief}>
        {fixes.map((fix) => (
          <li key={fix.listingId} className={dockStyles.briefCard}>
            <Link href={fix.href} className="flex min-w-0 flex-1 flex-col">
              <span>{fix.name}</span>
              <span className="text-sm font-normal text-muted-foreground">No {fix.missing.map((gap) => GAP_LABELS[gap]).join(", no ")}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
