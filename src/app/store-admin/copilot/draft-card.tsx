"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { CouponFields, DraftCard } from "@/lib/copilot/types";

const TITLE: Record<DraftCard["kind"], string> = {
  coupon: "New coupon",
  price: "Price change",
  store_change: "Store change",
  description: "Product description",
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function stateLine(card: DraftCard): string {
  if (card.state === "confirmed") return card.kind === "coupon" ? "Created" : "Done";
  if (card.state === "rejected") return "Dismissed";
  if (card.state === "expired") return "Expired. Ask again.";
  return "Waiting for you. Expires 24 hours after it was drafted.";
}

const COUPON_INPUTS: Array<{ name: keyof CouponFields; label: string; type: string; percent?: boolean; fixed?: boolean }> = [
  { name: "code", label: "Code", type: "text" },
  { name: "percentOff", label: "Percent off", type: "text", percent: true },
  { name: "amountOff", label: "Amount off ($)", type: "text", fixed: true },
  { name: "minGoods", label: "Minimum goods ($)", type: "text" },
  { name: "startsAt", label: "Starts", type: "datetime-local" },
  { name: "endsAt", label: "Ends", type: "datetime-local" },
  { name: "totalUses", label: "Total uses", type: "text" },
  { name: "usesPerCustomer", label: "Uses per customer", type: "text" },
];

/**
 * A coupon, price or store-change draft from the chat (#819). Nothing changes until Confirm; the owner can edit a
 * coupon's terms and untick price lines first.
 */
export function DraftCardView({
  card,
  disabled,
  writing,
  onConfirm,
  onDismiss,
}: {
  card: DraftCard;
  disabled: boolean;
  writing: boolean;
  onConfirm: (edits: { coupon?: CouponFields; variantIds?: string[]; description?: string }) => void;
  onDismiss: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<CouponFields | null>(card.kind === "coupon" ? card.fields : null);
  const [ticked, setTicked] = useState<string[]>(card.kind === "price" ? card.lines.map((line) => line.variantId) : []);
  const [description, setDescription] = useState(card.kind === "description" ? card.text : "");
  const open = card.state === "pending";

  return (
    <article className="rounded-xl border border-border bg-card px-4 py-4">
      <h3 className="font-display text-xl leading-tight font-bold text-foreground">{TITLE[card.kind]}</h3>

      {card.kind === "coupon" ? (
        editing && fields && open ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {COUPON_INPUTS.filter((input) => (fields.kind === "percent" ? !input.fixed : !input.percent)).map((input) => (
              <label key={input.name} className="flex flex-col gap-1 text-[0.8125rem] font-semibold text-foreground">
                {input.label}
                <input
                  type={input.type}
                  value={fields[input.name]}
                  disabled={disabled}
                  onChange={(event) => setFields({ ...fields, [input.name]: event.target.value })}
                  className="min-h-11 rounded-lg border border-border bg-background px-3 text-base font-normal text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              </label>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-base leading-6 text-foreground">{card.summary}</p>
        )
      ) : null}

      {card.kind === "price" ? (
        <fieldset className="mt-3">
          <legend className="sr-only">Prices to change</legend>
          <ul className="flex flex-col divide-y divide-border">
            {card.lines.map((line) => {
              const applied = card.applied ? card.applied.includes(line.variantId) : true;
              return (
                <li key={line.variantId} className="flex min-h-11 items-center gap-3 py-2">
                  {open ? (
                    <input
                      id={`line-${card.id}-${line.variantId}`}
                      type="checkbox"
                      className="size-5 shrink-0 accent-primary"
                      checked={ticked.includes(line.variantId)}
                      disabled={disabled}
                      onChange={(event) => setTicked((current) => (
                        event.target.checked ? [...current, line.variantId] : current.filter((id) => id !== line.variantId)
                      ))}
                    />
                  ) : null}
                  <label
                    htmlFor={open ? `line-${card.id}-${line.variantId}` : undefined}
                    className={`flex flex-1 flex-wrap items-baseline justify-between gap-x-3 text-base ${applied ? "text-foreground" : "text-muted-foreground line-through"}`}
                  >
                    <span>{line.name}</span>
                    <span className="font-semibold tabular-nums">
                      {money(line.beforeCents)} → {money(line.afterCents)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ) : null}

      {card.kind === "store_change" ? (
        <>
          <p className="mt-2 text-base leading-6 text-foreground">{card.text}</p>
          <p className="mt-1 text-sm font-semibold text-foreground">Until {card.ends}</p>
        </>
      ) : null}

      {card.kind === "description" ? (
        <>
          <p className="mt-1 text-sm font-semibold text-foreground">{card.name}</p>
          {open ? (
            <label className="mt-3 flex flex-col gap-1 text-[0.8125rem] font-semibold text-foreground">
              Description shoppers see
              <textarea
                value={description}
                maxLength={600}
                rows={4}
                disabled={disabled}
                onChange={(event) => setDescription(event.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-base leading-6 font-normal text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </label>
          ) : (
            <p className="mt-2 text-base leading-6 text-foreground">{card.text}</p>
          )}
        </>
      ) : null}

      <p className="mt-2 text-sm text-muted-foreground">{writing ? "Saving…" : stateLine(card)}</p>

      {open ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={disabled || (card.kind === "price" && ticked.length === 0) || (card.kind === "description" && !description.trim())}
            className="min-h-12 rounded-full px-6"
            onClick={() => onConfirm(
              card.kind === "coupon"
                ? (editing && fields ? { coupon: fields } : {})
                : card.kind === "price" ? { variantIds: ticked }
                  : card.kind === "description" ? { description } : {},
            )}
          >
            {card.kind === "coupon" ? "Create coupon"
              : card.kind === "price" ? `Change ${ticked.length} ${ticked.length === 1 ? "price" : "prices"}`
                : card.kind === "description" ? "Save description" : "Confirm"}
          </Button>
          {card.kind === "coupon" && !editing ? (
            <Button type="button" variant="outline" disabled={disabled} className="min-h-12 rounded-full px-6" onClick={() => setEditing(true)}>
              Edit terms
            </Button>
          ) : null}
          <Button type="button" variant="outline" disabled={disabled} className="min-h-12 rounded-full px-6" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </article>
  );
}
