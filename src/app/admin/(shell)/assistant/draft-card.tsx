"use client";

import { useState } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AdminDraftCard } from "@/lib/admin/assistant/drafts";

function stateLine(card: AdminDraftCard): string {
  if (card.state === "confirmed") return card.outcome ?? "Done.";
  if (card.state === "rejected") return "Dismissed. Nothing changed.";
  if (card.state === "expired") return "Expired after 24 hours. Nothing changed. Ask again.";
  if (card.state === "stale") return "The record changed since this was drafted, so nothing changed. Ask again for a fresh draft.";
  if (card.state === "applying") return "Applying…";
  return "Nothing changes until you confirm. Expires 24 hours after it was drafted.";
}

/** What the admin chose on the card before Confirm. */
export interface DraftChoice {
  text?: string;
  keep?: string[];
  image?: File;
}

/**
 * A change the admin assistant drafted (#832): what changes, from what to what, for which store. Nothing is applied
 * until Confirm; the one text on the card (a reply, a reason, a note, a slug) can be edited first. A workflow lists its
 * steps, a batch its items to untick, and a product card takes a photo (#833).
 */
export function AdminDraftCardView({
  card,
  disabled,
  onConfirm,
  onDismiss,
}: {
  card: AdminDraftCard;
  disabled: boolean;
  onConfirm: (choice: DraftChoice) => void;
  onDismiss: () => void;
}) {
  const [text, setText] = useState(card.editable?.text ?? "");
  const [kept, setKept] = useState<string[]>(() => card.items?.map((item) => item.key) ?? []);
  const [image, setImage] = useState<File | null>(null);
  const open = card.state === "pending";
  const fieldId = `draft-${card.id}-text`;
  const items = card.items ?? [];
  const toggle = (key: string, on: boolean) => setKept((current) => (on ? [...current, key] : current.filter((item) => item !== key)));

  return (
    <article aria-labelledby={`draft-${card.id}`} className="max-w-[65ch] rounded-xl border border-border bg-card px-4 py-4">
      <h3 id={`draft-${card.id}`} className="text-lg leading-tight font-semibold text-foreground">{card.title}</h3>
      {card.storeName ? <p className="mt-1 text-sm font-semibold text-muted-foreground">{card.storeName}</p> : null}

      {card.changes.length > 0 ? (
        <dl className="mt-3 flex flex-col divide-y divide-border">
          {card.changes.map((change) => (
            <div key={change.field} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <dt className="text-sm text-muted-foreground">{change.field}</dt>
              <dd className="text-base break-words text-foreground">
                <span className="text-muted-foreground">{change.from}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> to </span>
                <span className="font-semibold">{change.to}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {card.steps && card.steps.length > 0 ? (
        <div className="mt-3">
          <p className="text-[0.8125rem] font-semibold text-foreground">Steps, in this order</p>
          <ol className="mt-1 flex list-decimal flex-col gap-1 pl-5 text-base leading-6 text-foreground">
            {card.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
      ) : null}

      {items.length > 0 ? (
        <fieldset className="mt-3" disabled={!open || disabled}>
          <legend className="text-[0.8125rem] font-semibold text-foreground">
            {open ? `${kept.length} of ${items.length} ticked. Untick any to leave out.` : `${items.length} ${items.length === 1 ? "item" : "items"}`}
          </legend>
          <ul className="mt-1 flex flex-col divide-y divide-border">
            {items.map((item) => (
              <li key={item.key}>
                <label className="flex min-h-12 items-start gap-3 py-2 text-base leading-6 text-foreground">
                  {open ? (
                    <input
                      type="checkbox"
                      checked={kept.includes(item.key)}
                      onChange={(event) => toggle(item.key, event.target.checked)}
                      className="mt-1 size-5 shrink-0 accent-primary"
                    />
                  ) : null}
                  <span className="min-w-0 break-words">
                    {item.label}
                    {item.problems.length > 0 ? <span className="block text-sm text-destructive">{item.problems.join(", ")}</span> : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      {card.acceptsPhoto && open ? (
        <label htmlFor={`draft-${card.id}-photo`} className="mt-3 flex flex-col gap-1 text-[0.8125rem] font-semibold text-foreground">
          Product photo (optional, JPEG, PNG or WebP, up to 2 MB)
          <input
            id={`draft-${card.id}-photo`}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled}
            onChange={(event) => setImage(event.target.files?.[0] ?? null)}
            className="min-h-12 rounded-lg border border-border bg-background px-3 py-2 text-base font-normal text-foreground file:mr-3 file:rounded-full file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm file:font-semibold"
          />
        </label>
      ) : null}

      {card.editable ? (
        open ? (
          <label htmlFor={fieldId} className="mt-3 flex flex-col gap-1 text-[0.8125rem] font-semibold text-foreground">
            {card.editable.label}
            <textarea
              id={fieldId}
              value={text}
              maxLength={card.editable.max}
              rows={card.editable.max > 100 ? 3 : 1}
              disabled={disabled}
              onChange={(event) => setText(event.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-base leading-6 font-normal text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </label>
        ) : (
          <div className="mt-3">
            <p className="text-[0.8125rem] font-semibold text-foreground">{card.editable.label}</p>
            <p className="mt-1 text-base leading-6 whitespace-pre-wrap text-foreground">{card.editable.text || "None"}</p>
          </div>
        )
      ) : null}

      {card.warning && open ? (
        <p className="mt-3 flex items-start gap-2 text-sm font-semibold text-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <span>{card.warning}</span>
        </p>
      ) : null}

      <p className="mt-2 text-sm text-muted-foreground" aria-live="polite">{stateLine(card)}</p>

      {open ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={disabled || (card.editable !== null && !text.trim()) || (items.length > 0 && kept.length === 0)}
            className="min-h-12 rounded-full px-6"
            onClick={() => onConfirm({
              ...(card.editable ? { text } : {}),
              ...(items.length > 0 ? { keep: kept } : {}),
              ...(image ? { image } : {}),
            })}
          >
            Confirm
          </Button>
          <Button type="button" variant="outline" disabled={disabled} className="min-h-12 rounded-full px-6" onClick={onDismiss}>
            Dismiss
          </Button>
          {card.href ? (
            <Link href={card.href} className="inline-flex min-h-12 items-center px-2 text-sm font-semibold text-foreground underline-offset-4 hover:underline focus-visible:underline">
              Open the screen
            </Link>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
