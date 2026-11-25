import Link from "next/link";
import { ChevronLeft, Inbox } from "lucide-react";
import { listReviewInbox, readTranscript, type InboxRow } from "@/lib/admin/ai-oversight";
import {
  chatKey,
  CONVERSATION_KINDS,
  FLAG_REASON_TEXT,
  KIND_TEXT,
  nextUnlabelled,
  parseChatKey,
  REVIEW_LABEL_TEXT,
} from "@/lib/admin/ai-review";
import { InboxFilters, type InboxFilterState } from "./filters";
import { InboxKeys } from "./review-controls";
import { TranscriptPane } from "./transcript-pane";

export const metadata = { title: "AI conversations — Platform Admin" };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const SETTINGS_HREF = "/admin/settings/ai-onboarding";

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const timeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

function dayText(day: string): string {
  return dayFormat.format(new Date(`${day}T00:00:00.000Z`));
}

/** The list URL with these filters, and a chat open when one is given. */
function inboxHref(state: InboxFilterState, chat?: string): string {
  const params = new URLSearchParams();
  if (state.day) params.set("day", state.day);
  if (state.assistant) params.set("assistant", state.assistant);
  if (state.store) params.set("store", state.store);
  if (state.flagged) params.set("flagged", "1");
  if (state.unlabelled) params.set("unlabelled", "1");
  if (chat) params.set("chat", chat);
  const query = params.toString();
  return `/admin/ai/conversations${query ? `?${query}` : ""}`;
}

export default async function AiConversationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" && value ? value : undefined);
  const day = one(params.day);
  const inbox = await listReviewInbox({
    day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) ? day : undefined,
    kind: CONVERSATION_KINDS.find((kind) => kind === params.assistant),
    storeId: one(params.store),
    flagged: params.flagged === "1",
    unlabelled: params.unlabelled === "1",
  });
  const state: InboxFilterState = {
    day: inbox.day ?? "",
    assistant: inbox.filters.kind ?? "",
    store: inbox.filters.storeId ?? "",
    flagged: inbox.filters.flagged,
    unlabelled: inbox.filters.unlabelled,
  };

  const open = parseChatKey(one(params.chat));
  const openKey = open ? `${open.kind}:${open.id}` : null;
  const transcript = open ? await readTranscript(open) : null;
  const at = openKey ? inbox.rows.findIndex((row) => chatKey(row) === openKey) : -1;
  const next = inbox.rows[at + 1] ?? null;
  const prev = at > 0 ? inbox.rows[at - 1] ?? null : null;
  const following = openKey ? nextUnlabelled(inbox.rows, openKey) : null;
  const range = inbox.day ? `${dayText(inbox.day)} (UTC)` : `Last 7 days, ${dayText(inbox.from)} to ${dayText(inbox.to)} (UTC)`;

  return (
    <div className="mx-auto max-w-[90rem] px-4 py-8 sm:px-6 lg:py-10">
      <InboxKeys
        nextHref={next ? inboxHref(state, chatKey(next)) : null}
        prevHref={prev ? inboxHref(state, chatKey(prev)) : null}
      />
      <div className={open ? "hidden lg:block" : undefined}>
        <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">AI conversations</h1>
        <p className="mt-1 max-w-prose text-foreground">
          Check what the AI told shoppers and stores, and label its mistakes so they get fixed.
        </p>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          {inbox.samplePerStore > 0
            ? `Each day, up to ${inbox.samplePerStore} random chats per store from each assistant, ${inbox.samplePerStore} from the platform admin assistant, and every flagged chat.`
            : "Each day, every flagged chat. Random sampling is set to 0."}{" "}
          <Link href={SETTINGS_HREF} className={`rounded-sm text-foreground underline underline-offset-2 ${FOCUS}`}>
            Change the sample size
          </Link>
        </p>
        <InboxFilters state={state} counts={inbox.counts} stores={inbox.stores} />
      </div>

      {inbox.total === 0 ? (
        <EmptyRange range={range} picked={!!inbox.day} />
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
          <section
            aria-labelledby="list-title"
            className={`${open ? "hidden lg:block" : ""} lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto lg:rounded-xl lg:border lg:border-border lg:bg-card`}
          >
            <div className="flex items-baseline justify-between gap-3 border-b border-border px-1 pb-2 lg:px-4 lg:pt-3">
              <h2 id="list-title" className="text-sm font-semibold text-foreground">{range}</h2>
              <p className="shrink-0 text-sm tabular-nums text-muted-foreground" data-testid="inbox-count">
                {inbox.rows.length + inbox.hidden} {inbox.rows.length + inbox.hidden === 1 ? "chat" : "chats"}
              </p>
            </div>
            {inbox.rows.length === 0 ? (
              <p className="px-1 py-6 text-sm text-muted-foreground lg:px-4">
                No chats match these filters.{" "}
                <Link href={inboxHref({ ...state, assistant: "", store: "", flagged: false, unlabelled: false })} className={`rounded-sm text-foreground underline underline-offset-2 ${FOCUS}`}>
                  Show every chat in this range
                </Link>
              </p>
            ) : (
              <ul data-inbox-list className="divide-y divide-border">
                {inbox.rows.map((row) => (
                  <li key={chatKey(row)}>
                    <Row row={row} href={inboxHref(state, chatKey(row))} current={chatKey(row) === openKey} />
                  </li>
                ))}
              </ul>
            )}
            {inbox.hidden > 0 && (
              <p className="px-1 py-3 text-sm text-muted-foreground lg:px-4">{inbox.hidden} more not shown. Narrow the filters to see them.</p>
            )}
            <p className="hidden px-4 py-3 text-xs text-muted-foreground lg:block">Press J for the next chat and K for the previous one.</p>
          </section>

          <section aria-label="Chat" className={open ? "" : "hidden lg:block"}>
            {open && (
              <Link
                href={inboxHref(state)}
                className={`mb-4 inline-flex min-h-11 items-center gap-1 rounded-full pr-3 text-sm font-medium text-foreground lg:hidden ${FOCUS}`}
              >
                <ChevronLeft aria-hidden className="size-4" /> Back to the list
              </Link>
            )}
            {transcript ? (
              <TranscriptPane transcript={transcript} nextUnlabelledHref={following ? inboxHref(state, chatKey(following)) : null} />
            ) : (
              <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
                {open ? "That chat is no longer stored. Chats are deleted after 90 days." : "Pick a chat from the list to read it here."}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Row({ row, href, current }: { row: InboxRow; href: string; current: boolean }) {
  return (
    <Link
      href={href}
      scroll={false}
      prefetch={false}
      aria-current={current ? "true" : undefined}
      data-testid={`conversation-${row.id}`}
      className={`block px-1 py-3 hover:bg-muted focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring lg:px-4 ${current ? "bg-secondary hover:bg-secondary" : ""}`}
    >
      <span className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          <span className="font-semibold text-foreground">{row.storeName ?? "Platform"}</span> · {KIND_TEXT[row.kind]}
        </span>
        <time dateTime={row.lastMessageAt} className="shrink-0 tabular-nums">{timeFormat.format(new Date(row.lastMessageAt))}</time>
      </span>
      <span className="mt-1 line-clamp-2 break-words text-sm text-foreground">
        {row.firstQuestion || <span className="text-muted-foreground">No question in text</span>}
      </span>
      {(row.reasons.length > 0 || row.labels.length > 0) && (
        <span className="mt-2 flex flex-wrap gap-1.5">
          {row.reasons.map((reason) => (
            <span key={reason} className="rounded-full border border-input px-2 py-0.5 text-xs font-medium text-foreground">
              {FLAG_REASON_TEXT[reason]}
            </span>
          ))}
          {row.labels.map((label, index) => (
            <span key={`${label}-${index}`} className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
              Labelled: {REVIEW_LABEL_TEXT[label]}
            </span>
          ))}
        </span>
      )}
    </Link>
  );
}

function EmptyRange({ range, picked }: { range: string; picked: boolean }) {
  return (
    <section aria-labelledby="empty-title" className="mt-8 flex max-w-xl flex-col items-start gap-3 rounded-xl border border-border bg-card p-6" data-testid="inbox-empty">
      <Inbox aria-hidden className="size-6 text-muted-foreground" />
      <h2 id="empty-title" className="text-lg font-semibold text-foreground">Nothing to review</h2>
      <p className="text-muted-foreground">
        No chats were sampled or flagged for {range}. The sample takes a few random chats each day; a bigger sample gives you more to check.
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <Link href={SETTINGS_HREF} className={`inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground ${FOCUS}`}>
          Change the sample size
        </Link>
        {picked && (
          <Link href="/admin/ai/conversations" className={`inline-flex min-h-11 items-center rounded-sm px-2 text-sm text-foreground underline underline-offset-4 ${FOCUS}`}>
            Show the last 7 days
          </Link>
        )}
      </div>
    </section>
  );
}
