"use client";

import { useActionState, useEffect, useRef } from "react";
import { saveMetroAction, type MetroFormState } from "@/lib/admin/metro-actions";
import type { CourierSelectionMode, CourierSettings } from "@/lib/delivery/courier-settings";

type Range = { min: number; max: number };

export type MetroFormValues = {
  name: string;
  states: string[];
  centerLat: number;
  centerLng: number;
  radiusMi: number;
  courierSelectionMode: string | null;
  courierAssignmentTimeoutS: number | null;
  doordashEnabled: boolean;
  uberEnabled: boolean;
};

const MODE_LABELS: Record<CourierSelectionMode, string> = {
  cheapest: "Cheapest quote",
  doordash_first: "DoorDash first",
  uber_first: "Uber first",
};

const PROVIDERS = [
  { name: "doordashEnabled", label: "DoorDash Drive", platform: "doordashEnabled" },
  { name: "uberEnabled", label: "Uber Direct", platform: "uberEnabled" },
] as const;

const FIELD =
  "w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-destructive";

function Field({
  name,
  label,
  hint,
  error,
  defaultValue,
  className = "",
  inputMode,
  placeholder,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  defaultValue: string;
  className?: string;
  inputMode?: "numeric" | "decimal" | "text";
  placeholder?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={name} className="block text-sm font-medium text-foreground">{label}</label>
      <input
        id={name}
        name={name}
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${hint ? `${name}-hint ` : ""}${name}-error`}
        className={`mt-1 ${FIELD}`}
      />
      {hint && <p id={`${name}-hint`} className="mt-1 text-sm text-muted-foreground">{hint}</p>}
      {error && <p id={`${name}-error`} className="mt-1 text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** Creates a metro (metroId null) or edits one. The platform settings come from the page, so each "follow" choice names its value. */
export function MetroForm({
  metroId,
  metro,
  platform,
  limits,
}: {
  metroId: string | null;
  metro: MetroFormValues | null;
  platform: CourierSettings;
  limits: { radius: Range; timeout: Range; maxStates: number };
}) {
  const [state, formAction, pending] = useActionState<MetroFormState, FormData>(saveMetroAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.fieldErrors) formRef.current?.querySelector<HTMLElement>("[aria-invalid=true], [data-invalid=true] input")?.focus();
  }, [state]);
  const sent = state.submitted;
  const errors = state.fieldErrors ?? {};
  const value = (field: keyof NonNullable<MetroFormState["submitted"]>, fallback: string) => sent?.[field] ?? fallback;
  const mode = value("courierSelectionMode", metro?.courierSelectionMode ?? "");

  return (
    <form ref={formRef} action={formAction} className="space-y-6" aria-label={metroId ? "Edit metro" : "New metro"}>
      {metroId && <input type="hidden" name="metroId" value={metroId} />}
      <fieldset className="rounded-lg border border-border bg-card p-5">
        <legend className="px-1 text-base font-semibold text-foreground">Area</legend>
        <div className="mt-2 grid gap-5 sm:grid-cols-2">
          <Field name="name" label="Name" error={errors.name} defaultValue={value("name", metro?.name ?? "")} placeholder="Washington DC area" />
          <Field
            name="states"
            label="States"
            hint={`US state codes, up to ${limits.maxStates}. Shown on the readiness report for tax sign-off.`}
            error={errors.states}
            defaultValue={value("states", metro?.states.join(", ") ?? "")}
            placeholder="DC, MD, VA"
          />
          <Field name="centerLat" label="Centre latitude" inputMode="decimal" error={errors.centerLat} defaultValue={value("centerLat", metro ? String(metro.centerLat) : "")} placeholder="38.9072" />
          <Field name="centerLng" label="Centre longitude" inputMode="decimal" error={errors.centerLng} defaultValue={value("centerLng", metro ? String(metro.centerLng) : "")} placeholder="-77.0369" />
          <Field
            name="radiusMi"
            label="Radius in miles"
            inputMode="numeric"
            hint={`${limits.radius.min} to ${limits.radius.max}. For reference only: stores join a metro from their own page.`}
            error={errors.radiusMi}
            defaultValue={value("radiusMi", metro ? String(metro.radiusMi) : "")}
          />
        </div>
      </fieldset>

      <fieldset
        className="rounded-lg border border-border bg-card p-5"
        data-invalid={errors.courierSelectionMode ? true : undefined}
        aria-describedby={errors.courierSelectionMode ? "courierSelectionMode-error" : undefined}
      >
        <legend className="px-1 text-base font-semibold text-foreground">Which courier gets the order here</legend>
        <div className="mt-2 space-y-1">
          {[{ value: "", label: `Follow the platform (${MODE_LABELS[platform.selectionMode]})` }, ...Object.entries(MODE_LABELS).map(([v, label]) => ({ value: v, label }))].map((option) => (
            <label key={option.value || "platform"} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted">
              <input type="radio" name="courierSelectionMode" value={option.value} defaultChecked={mode === option.value} className="size-4 shrink-0 accent-primary" />
              <span className="text-sm font-medium text-foreground">{option.label}</span>
            </label>
          ))}
        </div>
        {errors.courierSelectionMode && <p id="courierSelectionMode-error" className="mt-2 text-sm text-destructive">{errors.courierSelectionMode}</p>}
      </fieldset>

      <fieldset className="rounded-lg border border-border bg-card p-5">
        <legend className="px-1 text-base font-semibold text-foreground">Couriers and timing here</legend>
        <p className="mt-1 text-sm text-muted-foreground">
          Off here stops a courier for this metro&apos;s stores. On follows the platform switch, so a courier switched off for every store stays off.
        </p>
        <ul className="mt-3 divide-y divide-border">
          {PROVIDERS.map((provider) => (
            <li key={provider.name} className="flex min-h-12 items-center justify-between gap-4 py-2">
              <label htmlFor={provider.name} className="text-sm font-medium text-foreground">
                {provider.label}
                {!platform[provider.platform] && <span className="block font-normal text-muted-foreground">Off for every store</span>}
              </label>
              <span className="relative inline-flex">
                <input
                  id={provider.name}
                  name={provider.name}
                  type="checkbox"
                  role="switch"
                  defaultChecked={sent ? sent[provider.name] === "on" : (metro?.[provider.name] ?? true)}
                  className="peer h-7 w-12 cursor-pointer appearance-none rounded-full border border-input bg-muted transition-colors checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1 top-1 size-5 rounded-full bg-muted-foreground transition-transform peer-checked:translate-x-5 peer-checked:bg-primary-foreground motion-reduce:transition-none"
                />
              </span>
            </li>
          ))}
        </ul>
        <Field
          className="mt-4 max-w-xs"
          name="courierAssignmentTimeoutS"
          label="Wait for a courier, in seconds"
          inputMode="numeric"
          hint={`Empty follows the platform (${platform.assignmentTimeoutSeconds} s). ${limits.timeout.min} to ${limits.timeout.max}.`}
          error={errors.courierAssignmentTimeoutS}
          defaultValue={value("courierAssignmentTimeoutS", metro?.courierAssignmentTimeoutS != null ? String(metro.courierAssignmentTimeoutS) : "")}
        />
      </fieldset>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
        >
          {pending ? "Saving…" : metroId ? "Save metro" : "Add metro"}
        </button>
        <p role="status" className="text-sm text-muted-foreground">
          {state.saved ? "Saved. The next quote and dispatch for these stores use it." : state.error ?? (state.fieldErrors ? "Nothing was saved. Fix the field marked above." : "")}
        </p>
      </div>
    </form>
  );
}
