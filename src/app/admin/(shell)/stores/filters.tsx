"use client";

import Form from "next/form";
import Link from "next/link";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Plus, Search } from "lucide-react";
import type { StoreFilters as Filters } from "@/lib/admin/store-views";

export interface FilterOption {
  value: string;
  label: string;
}

const SEARCH_DELAY_MS = 400;
const CHIPS = ["metro", "plan", "billing", "pilot"] as const;
type Chip = (typeof CHIPS)[number];
const CHIP_LABELS: Record<Chip, string> = { metro: "Metro", plan: "Plan", billing: "Billing", pilot: "Pilot" };

/**
 * The Stores page's search and filter chips (#859). A choice applies at once, as on the subscriptions page (#837):
 * it submits the GET form, so the URL keeps the filters. The search applies after a short pause in typing.
 */
export function StoreFilters({ filters, options }: { filters: Filters; options: Record<Chip, readonly FilterOption[]> }) {
  // Held in state, not remounted by key, so focus stays on the control after the list updates.
  const [chosen, setChosen] = useState(filters);
  const [fromUrl, setFromUrl] = useState(filters);
  if (CHIPS.some((chip) => fromUrl[chip] !== filters[chip]) || fromUrl.q !== filters.q || fromUrl.view !== filters.view) {
    setFromUrl(filters);
    setChosen(filters);
  }
  const form = useRef<HTMLFormElement>(null);
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(typing.current), []);

  // An empty control has no name, so the URL carries only the filters in use.
  function apply(chip: Chip, event: ChangeEvent<HTMLSelectElement>) {
    const { value } = event.currentTarget;
    event.currentTarget.name = value ? chip : "";
    setChosen((current) => ({ ...current, [chip]: value }));
    event.currentTarget.form?.requestSubmit();
  }

  const filtered = CHIPS.some((chip) => filters[chip]) || !!filters.q;

  return (
    <Form ref={form} action="/admin/stores" className="mt-3 flex flex-wrap items-center gap-2">
      {filters.view !== "all" && <input type="hidden" name="view" value={filters.view} />}
      <label className="relative min-w-0 flex-1 basis-full sm:max-w-64 sm:basis-64">
        <span className="sr-only">Search stores</span>
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          name={chosen.q ? "q" : undefined}
          value={chosen.q}
          maxLength={100}
          autoComplete="off"
          placeholder="Name or slug…"
          onChange={(event) => {
            const value = event.currentTarget.value;
            event.currentTarget.name = value ? "q" : "";
            setChosen((current) => ({ ...current, q: value }));
            clearTimeout(typing.current);
            typing.current = setTimeout(() => form.current?.requestSubmit(), SEARCH_DELAY_MS);
          }}
          className="h-11 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-9 sm:text-sm"
        />
      </label>
      {CHIPS.map((chip) => {
        const set = chosen[chip] !== "";
        return (
          <label
            key={chip}
            className={`relative inline-flex h-11 items-center gap-1.5 rounded-full border px-3 text-sm text-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring sm:h-9 ${
              set ? "border-foreground bg-card font-medium" : "border-dashed border-input hover:bg-muted"
            }`}
          >
            {!set && <Plus aria-hidden className="size-4 text-muted-foreground" />}
            <span className={set ? "text-muted-foreground" : ""}>{CHIP_LABELS[chip]}{set ? ":" : ""}</span>
            <select
              name={chosen[chip] ? chip : undefined}
              aria-label={CHIP_LABELS[chip]}
              value={chosen[chip]}
              onChange={(event) => apply(chip, event)}
              className={`${set ? "" : "absolute inset-0 opacity-0"} cursor-pointer appearance-none bg-transparent pr-1 outline-none`}
            >
              <option value="">Any {CHIP_LABELS[chip].toLowerCase()}</option>
              {options[chip].map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        );
      })}
      <noscript>
        <button type="submit" className="h-9 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground">Filter</button>
      </noscript>
      {filtered && (
        <Link
          href={filters.view === "all" ? "/admin/stores" : `/admin/stores?view=${filters.view}`}
          className="flex h-11 items-center rounded px-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-9"
        >
          Clear
        </Link>
      )}
    </Form>
  );
}
