"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { saveReorder, updateReorderDays } from "@/lib/copilot/reorder-actions";
import type { ReorderRow } from "@/lib/copilot/reorder";

const ACTION = buttonVariants({ variant: "outline", className: "min-h-11 rounded-full px-4" });
const INPUT = "min-h-11 rounded-lg border border-border bg-background px-3 text-base text-foreground tabular-nums";
const savedLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export interface SavedListView {
  savedAt: string;
  items: Array<{ listingId: string; name: string; quantity: number | null }>;
  text: string;
}

function rowNote(row: ReorderRow): string {
  if (row.suggested === null) return `Marked ${row.status === "low" ? "low" : "out"}, ${row.sold28} sold in 28 days. Counts not tracked.`;
  return `${row.onHand} on hand · ${row.sold28} sold in 28 days, about ${row.perDay} a day`;
}

function wholeNumber(raw: string): number | null | "bad" {
  if (raw === "") return null;
  return /^\d{1,6}$/.test(raw) ? Number(raw) : "bad";
}

function DaysForm({ leadDays, coverDays }: { leadDays: number; coverDays: number }) {
  const id = useId();
  const router = useRouter();
  const [lead, setLead] = useState(String(leadDays));
  const [cover, setCover] = useState(String(coverDays));
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    const leadValue = wholeNumber(lead.trim());
    const coverValue = wholeNumber(cover.trim());
    if (typeof leadValue !== "number" || typeof coverValue !== "number") {
      setNotice("Whole days only.");
      return;
    }
    startTransition(async () => {
      const result = await updateReorderDays({ leadDays: leadValue, coverDays: coverValue });
      setNotice(result.ok ? "Saved." : result.message);
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label htmlFor={`${id}-lead`} className="flex flex-col gap-1 text-sm text-muted-foreground">
        Lead time (days)
        <input id={`${id}-lead`} inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value)} className={`${INPUT} w-24`} />
      </label>
      <label htmlFor={`${id}-cover`} className="flex flex-col gap-1 text-sm text-muted-foreground">
        Cover (days)
        <input id={`${id}-cover`} inputMode="numeric" value={cover} onChange={(e) => setCover(e.target.value)} className={`${INPUT} w-24`} />
      </label>
      <Button type="button" variant="outline" className="min-h-11 rounded-full px-4" disabled={pending} onClick={save}>
        {pending ? "Saving…" : "Save days"}
      </Button>
      {notice ? <p role="status" className="basis-full text-sm text-muted-foreground">{notice}</p> : null}
    </div>
  );
}

function SavedList({ saved, storeSlug }: { saved: SavedListView; storeSlug: string }) {
  const titleId = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const store = encodeURIComponent(storeSlug);

  async function copy() {
    try {
      await navigator.clipboard.writeText(saved.text);
      setCopied("Copied.");
    } catch {
      setCopied("Could not copy. Select the list and copy it.");
    }
  }

  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-border bg-card">
      <div className="px-4 pt-4">
        <h3 id={titleId} className="text-base font-semibold text-foreground">Saved reorder list</h3>
        <p className="text-sm text-muted-foreground">{`Draft saved ${savedLabel.format(new Date(saved.savedAt))}. Nothing is ordered.`}</p>
      </div>
      <ul className="mt-2 divide-y divide-border">
        {saved.items.map((item) => (
          <li key={item.listingId} className="flex items-baseline justify-between gap-3 px-4 py-2">
            <span className="min-w-0 truncate text-base text-foreground">{item.name}</span>
            <span className="shrink-0 text-base font-semibold text-foreground tabular-nums">{item.quantity ?? "Reorder (no count)"}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        <a
          href={`/store-admin/copilot/reorder/export?store=${store}`}
          className={ACTION}
        >
          Download CSV
        </a>
        <Link
          href={`/store-admin/copilot/reorder/print?store=${store}`}
          className={ACTION}
        >
          Print
        </Link>
        <button type="button" className={ACTION} onClick={copy}>
          Copy as text
        </button>
        {copied ? <p role="status" className="text-sm text-muted-foreground">{copied}</p> : null}
      </div>
    </section>
  );
}

export function ReorderPanel({
  rows,
  leadDays,
  coverDays,
  saved,
  storeSlug,
}: {
  rows: ReorderRow[];
  leadDays: number;
  coverDays: number;
  saved: SavedListView | null;
  storeSlug: string;
}) {
  const router = useRouter();
  const savedQty = new Map(saved?.items.map((item) => [item.listingId, item.quantity]) ?? []);
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => {
      const start = savedQty.has(row.listingId) ? savedQty.get(row.listingId) : row.suggested;
      return [row.listingId, start == null ? "" : String(start)];
    })),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    const lines: Array<{ listingId: string; quantity: number | null }> = [];
    for (const row of rows) {
      const value = wholeNumber((quantities[row.listingId] ?? "").trim());
      if (value === "bad") {
        setNotice(`Whole numbers only, for ${row.name}.`);
        return;
      }
      // A blank count on a counted item leaves it off; on a status item it stays "reorder (no count)".
      lines.push({ listingId: row.listingId, quantity: value === null && row.suggested !== null ? 0 : value });
    }
    startTransition(async () => {
      const result = await saveReorder({ lines });
      setNotice(result.ok ? "Reorder list saved." : result.message);
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <DaysForm leadDays={leadDays} coverDays={coverDays} />
      {rows.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-4 text-base text-muted-foreground">Nothing to reorder right now.</p>
      ) : (
        <div className="rounded-xl border border-border bg-card">
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.listingId} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-foreground">{row.name}</p>
                  <p className="text-sm text-muted-foreground tabular-nums">{rowNote(row)}</p>
                </div>
                <label className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
                  {row.suggested === null ? "Order" : `Suggested ${row.suggested}`}
                  <input
                    aria-label={`Order quantity for ${row.name}`}
                    inputMode="numeric"
                    placeholder={row.suggested === null ? "No count" : undefined}
                    value={quantities[row.listingId] ?? ""}
                    onChange={(e) => setQuantities((current) => ({ ...current, [row.listingId]: e.target.value }))}
                    className={`${INPUT} w-24 text-right`}
                  />
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
            <Button type="button" className="min-h-11 rounded-full px-4" disabled={pending} onClick={save}>
              {pending ? "Saving…" : "Save reorder list"}
            </Button>
            {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
          </div>
        </div>
      )}
      {saved ? <SavedList saved={saved} storeSlug={storeSlug} /> : null}
    </div>
  );
}
