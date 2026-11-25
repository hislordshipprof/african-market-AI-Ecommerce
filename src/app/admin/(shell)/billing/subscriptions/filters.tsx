"use client";

import Form from "next/form";
import Link from "next/link";
import { useState, type ChangeEvent } from "react";

export interface FilterOption {
  value: string;
  label: string;
}

const FIELD = "min-h-11 rounded-lg border border-input bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";


export function SubscriptionFilters({ status, plan, statusOptions, planOptions }: {
  status: string;
  plan: string;
  statusOptions: readonly FilterOption[];
  planOptions: readonly FilterOption[];
}) {
  // Held in state, not remounted by key, so focus stays on the select after the list updates.
  const [chosen, setChosen] = useState({ status, plan });
  const [fromUrl, setFromUrl] = useState({ status, plan });
  if (fromUrl.status !== status || fromUrl.plan !== plan) {
    setFromUrl({ status, plan });
    setChosen({ status, plan });
  }

  /** A choice submits the GET form, so the list updates at once and the URL keeps ?status=&plan=. */
  function apply(event: ChangeEvent<HTMLSelectElement>) {
    const { name, value, form } = event.currentTarget;
    setChosen((c) => ({ ...c, [name]: value }));
    form?.requestSubmit();
  }

  return (
    <Form action="/admin/billing/subscriptions" className="mt-3 flex flex-wrap items-start gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor="filter-status" className="text-sm font-medium text-foreground">Status</label>
        <select id="filter-status" name="status" value={chosen.status} onChange={apply} className={FIELD}>
          {statusOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor="filter-plan" className="text-sm font-medium text-foreground">Plan</label>
        <select id="filter-plan" name="plan" value={chosen.plan} onChange={apply} aria-describedby="filter-plan-hint" className={FIELD}>
          {planOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <p id="filter-plan-hint" className="text-xs text-muted-foreground">Counts the plan in force; an override wins.</p>
      </div>
      <noscript>
        <button type="submit" className="mt-6 min-h-11 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          Filter
        </button>
      </noscript>
      {(status || plan) && (
        <Link href="/admin/billing/subscriptions" className="mt-6 flex min-h-11 items-center px-2 text-sm text-primary underline-offset-4 hover:underline">
          Clear filters
        </Link>
      )}
    </Form>
  );
}
