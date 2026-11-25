"use client";

import Form from "next/form";
import Link from "next/link";
import { useState, type ChangeEvent } from "react";
import { Check } from "lucide-react";
import { CONVERSATION_KINDS, KIND_TEXT, type ConversationKind } from "@/lib/admin/ai-review";

export interface InboxFilterState {
  day: string;
  assistant: "" | ConversationKind;
  store: string;
  flagged: boolean;
  unlabelled: boolean;
}

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const FIELD = `min-h-11 rounded-lg border border-input bg-background px-3 text-base text-foreground ${FOCUS}`;
const CHIP = "inline-flex min-h-11 cursor-pointer select-none items-center gap-1.5 rounded-full border border-input px-4 text-sm font-medium text-foreground hover:bg-muted has-[:checked]:border-primary has-[:checked]:bg-secondary has-[:checked]:ring-1 has-[:checked]:ring-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring";

function Chip({ name, value, type, checked, onChange, children }: {
  name: string;
  value: string;
  type: "radio" | "checkbox";
  checked: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <label className={CHIP}>
      <input type={type} name={name} value={value} checked={checked} onChange={onChange} className="sr-only" />
      {checked && <Check aria-hidden className="size-4 text-primary" />}
      {children}
    </label>
  );
}

/** Filters apply on change, as the subscription filters do (#837): each change submits the GET form. */
export function InboxFilters({ state, counts, stores }: {
  state: InboxFilterState;
  counts: { kind: Record<"all" | ConversationKind, number>; store: Record<string, number>; flagged: number; unlabelled: number };
  stores: Array<{ id: string; name: string }>;
}) {
  // Held in state, not remounted by key, so focus stays on the control after the list updates.
  const [chosen, setChosen] = useState(state);
  const [fromUrl, setFromUrl] = useState(state);
  if (JSON.stringify(fromUrl) !== JSON.stringify(state)) {
    setFromUrl(state);
    setChosen(state);
  }

  function apply(event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value, form, type } = event.currentTarget;
    const next = type === "checkbox" ? (event.currentTarget as HTMLInputElement).checked : value;
    setChosen((current) => ({ ...current, [name]: next }));
    // A date box fires while the year is still being typed; wait for a plausible one.
    if (name === "day" && value && Number(value.slice(0, 4)) < 2000) return;
    form?.requestSubmit();
  }

  // Stores with chats to review, plus the one picked.
  const storeOptions = stores.filter((store) => (counts.store[store.id] ?? 0) > 0 || store.id === chosen.store);
  const filtered = state.day || state.assistant || state.store || state.flagged || state.unlabelled;

  return (
    <Form action="/admin/ai/conversations" className="mt-5 grid gap-3" aria-label="Filter chats">
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Assistant</legend>
        <Chip name="assistant" value="" type="radio" checked={chosen.assistant === ""} onChange={apply}>
          All assistants <span className="tabular-nums text-muted-foreground">{counts.kind.all}</span>
        </Chip>
        {CONVERSATION_KINDS.map((kind) => (
          <Chip key={kind} name="assistant" value={kind} type="radio" checked={chosen.assistant === kind} onChange={apply}>
            {KIND_TEXT[kind]} <span className="tabular-nums text-muted-foreground">{counts.kind[kind]}</span>
          </Chip>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-end gap-2">
        <Chip name="flagged" value="1" type="checkbox" checked={chosen.flagged} onChange={apply}>
          Flagged only <span className="tabular-nums text-muted-foreground">{counts.flagged}</span>
        </Chip>
        <Chip name="unlabelled" value="1" type="checkbox" checked={chosen.unlabelled} onChange={apply}>
          Unlabelled only <span className="tabular-nums text-muted-foreground">{counts.unlabelled}</span>
        </Chip>
        <label className="sr-only" htmlFor="filter-store">Store</label>
        <select id="filter-store" name="store" value={chosen.store} onChange={apply} className={`${FIELD} max-w-full sm:max-w-64`}>
          <option value="">All stores ({counts.store.all})</option>
          {storeOptions.map((store) => (
            <option key={store.id} value={store.id}>{store.name} ({counts.store[store.id] ?? 0})</option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <label htmlFor="filter-day" className="text-sm font-medium text-foreground">Day (UTC)</label>
          <input id="filter-day" type="date" name="day" value={chosen.day} onChange={apply} className={FIELD} />
        </div>
        <noscript>
          <button type="submit" className={`min-h-11 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground ${FOCUS}`}>
            Filter
          </button>
        </noscript>
        {filtered && (
          <Link href="/admin/ai/conversations" className={`flex min-h-11 items-center rounded-sm px-2 text-sm text-foreground underline underline-offset-4 ${FOCUS}`}>
            Clear filters
          </Link>
        )}
      </div>
    </Form>
  );
}
