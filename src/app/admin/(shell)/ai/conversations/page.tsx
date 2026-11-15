import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { listConversationSample, type SampleRow } from "@/lib/admin/ai-oversight";
import { FLAG_REASON_TEXT, REVIEW_LABEL_TEXT } from "@/lib/admin/ai-review";

export const metadata = { title: "AI conversations — Platform Admin" };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + by * 86_400_000).toISOString().slice(0, 10);
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${day}T00:00:00.000Z`));
}

function query(day: string, storeId: string | null): string {
  const params = new URLSearchParams({ day });
  if (storeId) params.set("store", storeId);
  return `?${params.toString()}`;
}

export default async function AiConversationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" && value ? value : undefined);
  const sample = await listConversationSample({ day: one(params.day), storeId: one(params.store) });
  const { day, storeId } = sample;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">AI conversations</h1>
      <p className="mt-1 max-w-prose text-muted-foreground">
        {sample.samplePerStore > 0
          ? `Up to ${sample.samplePerStore} random shopper chats and ${sample.samplePerStore} random copilot chats per store for each UTC day, plus every chat that was flagged.`
          : "Every chat that was flagged for each UTC day. Random sampling is set to 0."}{" "}
        <Link href="/admin/settings/ai-onboarding" className={`rounded-sm text-foreground underline underline-offset-2 ${FOCUS}`}>
          Change the sample size or cost flag
        </Link>
      </p>

      <form method="get" className="mt-6 grid gap-3 rounded-xl border border-border bg-card p-4 sm:flex sm:flex-wrap sm:items-end">
        <label className="grid gap-1 text-sm font-medium text-foreground">
          Day (UTC)
          <input
            type="date"
            name="day"
            defaultValue={day}
            className={`min-h-11 rounded-md border border-input bg-background px-3 text-base text-foreground ${FOCUS}`}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-medium text-foreground sm:w-72">
          Store
          <select
            name="store"
            defaultValue={storeId ?? ""}
            className={`min-h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground ${FOCUS}`}
          >
            <option value="">All stores</option>
            {sample.stores.map((store) => (
              <option key={store.id} value={store.id}>{store.name}</option>
            ))}
          </select>
        </label>
        <button type="submit" className={`min-h-11 w-fit rounded-full border border-input px-5 text-sm font-medium text-foreground hover:bg-muted ${FOCUS}`}>
          Show
        </button>
      </form>

      <nav aria-label="Day" className="mt-4 flex items-center justify-between gap-2 text-sm">
        <Link href={query(shiftDay(day, -1), storeId)} className={`inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-muted-foreground hover:bg-muted hover:text-foreground ${FOCUS}`}>
          <ChevronLeft aria-hidden className="size-4" /> Previous day
        </Link>
        <span className="font-medium text-foreground" data-testid="sample-day">{dayLabel(day)}</span>
        <Link href={query(shiftDay(day, 1), storeId)} className={`inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-muted-foreground hover:bg-muted hover:text-foreground ${FOCUS}`}>
          Next day <ChevronRight aria-hidden className="size-4" />
        </Link>
      </nav>

      <Section title="Shopper assistant" kindLabel="shopper chats" rows={sample.shopper} hidden={sample.hidden.shopper} testId="shopper-sample" />
      <Section title="Store copilot" kindLabel="copilot chats" rows={sample.copilot} hidden={sample.hidden.copilot} testId="copilot-sample" />
    </div>
  );
}

function Section({ title, kindLabel, rows, hidden, testId }: { title: string; kindLabel: string; rows: SampleRow[]; hidden: number; testId: string }) {
  const groups: Array<{ storeId: string; storeName: string; rows: SampleRow[] }> = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.storeId === row.storeId) last.rows.push(row);
    else groups.push({ storeId: row.storeId, storeName: row.storeName, rows: [row] });
  }
  const flagged = rows.filter((row) => row.reasons.length > 0).length;

  return (
    <section className="mt-10" aria-labelledby={`${testId}-title`} data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 id={`${testId}-title`} className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">
          {rows.length} {rows.length === 1 ? "chat" : "chats"}, {flagged} flagged
        </p>
      </div>
      {groups.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">No {kindLabel} on this day.</p>
      ) : (
        <div className="grid gap-6">
          {groups.map((group) => (
            <div key={group.storeId}>
              <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{group.storeName}</h3>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {group.rows.map((row) => (
                  <li key={row.id}>
                    <ConversationLink row={row} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {hidden > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          {hidden} more not shown. Pick a store to see all of its chats.
        </p>
      )}
    </section>
  );
}

function ConversationLink({ row }: { row: SampleRow }) {
  const time = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })
    .format(new Date(row.lastMessageAt));
  return (
    <Link
      href={`/admin/ai/conversations/${row.kind}/${encodeURIComponent(row.id)}`}
      prefetch={false}
      data-testid={`conversation-${row.id}`}
      className="group flex min-h-16 items-center gap-4 px-4 py-3 hover:bg-muted focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring sm:px-5"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">
          <span className="font-medium">Last message {time} UTC</span>
          <span className="text-muted-foreground"> · {row.messageCount} {row.messageCount === 1 ? "message" : "messages"}</span>
          {row.sampled && <span className="text-muted-foreground"> · In sample</span>}
        </span>
        {(row.reasons.length > 0 || row.labels.length > 0) && (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {row.reasons.map((reason) => (
              <span key={reason} className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground">
                {FLAG_REASON_TEXT[reason]}
              </span>
            ))}
            {row.labels.map((label, index) => (
              <span key={`${label}-${index}`} className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-foreground">
                Labelled: {REVIEW_LABEL_TEXT[label]}
              </span>
            ))}
          </span>
        )}
      </span>
      <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground group-hover:text-foreground" />
    </Link>
  );
}
