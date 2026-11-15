"use client";

import { useActionState, useEffect, useRef } from "react";
import { saveAiOnboardingSettingsAction, type AiOnboardingSettingsFormState } from "@/lib/admin/ai-onboarding-settings-actions";
import type { AiOnboardingSettings } from "@/lib/admin/ai-onboarding-settings";

type Field = keyof AiOnboardingSettings;
type Limits = Record<Field, { readonly min: number; readonly max: number }>;

/** The column defaults in the #561 migration. */
const DEFAULTS: AiOnboardingSettings = { goLiveListingFloor: 20, dailySamplePerStore: 5, turnCostFlagCents: 2, rejectedApplicationRetentionMonths: 12 };

const SECTIONS: Array<{ legend: string; fields: Array<{ name: Field; label: string; unit: string; hint: string }> }> = [
  {
    legend: "Store onboarding",
    fields: [
      {
        name: "goLiveListingFloor",
        label: "Listings needed to go live",
        unit: "listings",
        hint: "Active listings with a price a new store needs before Go live turns on.",
      },
      {
        name: "rejectedApplicationRetentionMonths",
        label: "Keep rejected applications",
        unit: "months",
        hint: "Then the daily job deletes them.",
      },
    ],
  },
  {
    legend: "AI review",
    fields: [
      {
        name: "dailySamplePerStore",
        label: "Random chats per store each day",
        unit: "chats",
        hint: "For shopper chats and copilot chats each, in AI conversations. 0 shows only flagged chats.",
      },
      {
        name: "turnCostFlagCents",
        label: "Flag a turn that costs more than",
        unit: "cents",
        hint: "A shopper assistant turn usually costs about a tenth of a cent. Shopper turns already saved keep their flag.",
      },
    ],
  },
];

const inputClass =
  "w-28 rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground tabular-nums focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-destructive";

/** The ranges come from the page: the settings module reads the database and stays on the server. */
export function AiOnboardingSettingsForm({ settings, limits }: { settings: AiOnboardingSettings; limits: Limits }) {
  const [state, formAction, pending] = useActionState<AiOnboardingSettingsFormState, FormData>(saveAiOnboardingSettingsAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.fieldErrors) formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
  }, [state]);
  const errors = state.fieldErrors ?? {};

  return (
    <form ref={formRef} action={formAction} className="mt-8 space-y-6">
      {SECTIONS.map((section) => (
        <fieldset key={section.legend} className="rounded-lg border border-border bg-card p-5">
          <legend className="px-1 text-base font-semibold text-foreground">{section.legend}</legend>
          <div className="mt-2 grid gap-5 sm:grid-cols-2">
            {section.fields.map((field) => (
              <div key={field.name}>
                <label htmlFor={field.name} className="block text-sm font-medium text-foreground">{field.label}</label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    id={field.name}
                    name={field.name}
                    type="number"
                    inputMode="numeric"
                    autoComplete="off"
                    required
                    min={limits[field.name].min}
                    max={limits[field.name].max}
                    step={1}
                    defaultValue={state.submitted?.[field.name] ?? settings[field.name]}
                    aria-invalid={errors[field.name] ? true : undefined}
                    aria-describedby={`${field.name}-hint${errors[field.name] ? ` ${field.name}-error` : ""}`}
                    className={inputClass}
                  />
                  <span className="text-sm text-muted-foreground">{field.unit}</span>
                </div>
                <p id={`${field.name}-hint`} className="mt-1 text-sm text-muted-foreground">
                  {field.hint} {limits[field.name].min} to {limits[field.name].max}; default {DEFAULTS[field.name]}.
                </p>
                {errors[field.name] && <p id={`${field.name}-error`} className="mt-1 text-sm text-destructive">{errors[field.name]}</p>}
              </div>
            ))}
          </div>
        </fieldset>
      ))}

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
        <p role="status" className="text-sm text-muted-foreground">
          {state.saved ? "Saved. Each feature uses these from its next run." : state.fieldErrors ? "Nothing was saved. Fix the field marked above." : ""}
        </p>
      </div>
    </form>
  );
}
