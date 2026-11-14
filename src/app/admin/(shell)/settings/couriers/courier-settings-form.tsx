"use client";

import { useActionState, useState } from "react";
import { saveCourierSettingsAction, type CourierSettingsFormState } from "@/lib/admin/courier-settings-actions";
import { ASSIGNMENT_TIMEOUT_SECONDS, COURIER_WEIGHT_LIMIT_LB, type CourierSelectionMode, type CourierSettings } from "@/lib/delivery/courier-settings";

const MODES: Array<{ value: CourierSelectionMode; label: string; hint: string }> = [
  { value: "cheapest", label: "Cheapest quote", hint: "Ask both couriers and book the lower fee." },
  { value: "doordash_first", label: "DoorDash first", hint: "Book DoorDash Drive whenever it quotes. Uber Direct only when it can't." },
  { value: "uber_first", label: "Uber first", hint: "Book Uber Direct whenever it quotes. DoorDash Drive only when it can't." },
];

const PROVIDERS = [
  { name: "doordashEnabled", label: "DoorDash Drive" },
  { name: "uberEnabled", label: "Uber Direct" },
] as const;

const inputClass =
  "w-28 rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground tabular-nums focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-destructive";

function minutes(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

export function CourierSettingsForm({ settings }: { settings: CourierSettings }) {
  const [state, formAction, pending] = useActionState<CourierSettingsFormState, FormData>(saveCourierSettingsAction, {});
  const sent = state.submitted;
  const [timeout, setTimeoutSeconds] = useState(sent?.assignmentTimeoutSeconds ?? String(settings.assignmentTimeoutSeconds));
  const [enabled, setEnabled] = useState({ doordashEnabled: settings.doordashEnabled, uberEnabled: settings.uberEnabled });
  const errors = state.fieldErrors ?? {};
  const bothOff = !enabled.doordashEnabled && !enabled.uberEnabled;

  return (
    <form action={formAction} className="mt-8 space-y-6">
      <fieldset className="rounded-lg border border-border bg-card p-5" aria-describedby={errors.selectionMode ? "selectionMode-error" : undefined}>
        <legend className="px-1 text-base font-semibold text-foreground">Which courier gets the order</legend>
        <div className="mt-2 space-y-1">
          {MODES.map((mode) => (
            <label key={mode.value} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-muted">
              <input
                type="radio"
                name="selectionMode"
                value={mode.value}
                defaultChecked={(sent?.selectionMode ?? settings.selectionMode) === mode.value}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">{mode.label}</span>
                <span className="block text-sm text-muted-foreground">{mode.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {errors.selectionMode && <p id="selectionMode-error" className="mt-2 text-sm text-destructive">{errors.selectionMode}</p>}
      </fieldset>

      <fieldset className="rounded-lg border border-border bg-card p-5">
        <legend className="px-1 text-base font-semibold text-foreground">Couriers</legend>
        <p className="mt-1 text-sm text-muted-foreground">
          A courier that is off is never quoted or booked. Turning one off does not cancel deliveries already booked with it.
        </p>
        <ul className="mt-3 divide-y divide-border">
          {PROVIDERS.map((provider) => (
            <li key={provider.name} className="flex min-h-12 items-center justify-between gap-4 py-2">
              <label htmlFor={provider.name} className="text-sm font-medium text-foreground">{provider.label}</label>
              <span className="flex items-center gap-3">
                <span className="w-6 text-right text-sm text-muted-foreground" aria-hidden="true">{enabled[provider.name] ? "On" : "Off"}</span>
                <span className="relative inline-flex">
                  <input
                    id={provider.name}
                    name={provider.name}
                    type="checkbox"
                    role="switch"
                    checked={enabled[provider.name]}
                    onChange={(e) => setEnabled((prev) => ({ ...prev, [provider.name]: e.target.checked }))}
                    className="peer h-7 w-12 cursor-pointer appearance-none rounded-full border border-input bg-muted transition-colors checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-1 top-1 size-5 rounded-full bg-card shadow-sm transition-transform peer-checked:translate-x-5 motion-reduce:transition-none"
                  />
                </span>
              </span>
            </li>
          ))}
        </ul>
        {bothOff && (
          <p role="status" className="mt-3 rounded-md border border-border bg-muted p-3 text-sm text-foreground">
            With both couriers off, checkout offers no courier delivery. Stores keep pickup and their own delivery.
          </p>
        )}
      </fieldset>

      <fieldset className="rounded-lg border border-border bg-card p-5">
        <legend className="px-1 text-base font-semibold text-foreground">Timing and weight</legend>
        <div className="mt-2 grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="assignmentTimeoutSeconds" className="block text-sm font-medium text-foreground">
              Wait for a courier
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="assignmentTimeoutSeconds"
                name="assignmentTimeoutSeconds"
                type="number"
                inputMode="numeric"
                required
                min={ASSIGNMENT_TIMEOUT_SECONDS.min}
                max={ASSIGNMENT_TIMEOUT_SECONDS.max}
                step={1}
                value={timeout}
                onChange={(e) => setTimeoutSeconds(e.target.value)}
                aria-invalid={errors.assignmentTimeoutSeconds ? true : undefined}
                aria-describedby="assignmentTimeoutSeconds-hint assignmentTimeoutSeconds-error"
                className={inputClass}
              />
              <span className="text-sm text-muted-foreground">seconds</span>
            </div>
            <p id="assignmentTimeoutSeconds-hint" className="mt-1 text-sm text-muted-foreground">
              <span className="text-foreground">{minutes(Number(timeout))}</span>
              {minutes(Number(timeout)) && ". "}
              No courier by then, the order moves to the other courier. {ASSIGNMENT_TIMEOUT_SECONDS.min} to {ASSIGNMENT_TIMEOUT_SECONDS.max}; default 600.
            </p>
            {errors.assignmentTimeoutSeconds && (
              <p id="assignmentTimeoutSeconds-error" className="mt-1 text-sm text-destructive">{errors.assignmentTimeoutSeconds}</p>
            )}
          </div>
          <div>
            <label htmlFor="weightLimitLb" className="block text-sm font-medium text-foreground">
              Courier weight limit
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="weightLimitLb"
                name="weightLimitLb"
                type="number"
                inputMode="numeric"
                required
                min={COURIER_WEIGHT_LIMIT_LB.min}
                max={COURIER_WEIGHT_LIMIT_LB.max}
                step={1}
                defaultValue={sent?.weightLimitLb ?? settings.weightLimitLb}
                aria-invalid={errors.weightLimitLb ? true : undefined}
                aria-describedby="weightLimitLb-hint weightLimitLb-error"
                className={inputClass}
              />
              <span className="text-sm text-muted-foreground">lb</span>
            </div>
            <p id="weightLimitLb-hint" className="mt-1 text-sm text-muted-foreground">
              Per item and per order. Heavier orders get pickup or store delivery.
            </p>
            {errors.weightLimitLb && <p id="weightLimitLb-error" className="mt-1 text-sm text-destructive">{errors.weightLimitLb}</p>}
          </div>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save courier settings"}
        </button>
        <p role="status" className="text-sm text-muted-foreground">
          {state.saved ? "Saved. The next quote and dispatch use these settings." : state.fieldErrors ? "Nothing was saved. Fix the field marked above." : ""}
        </p>
      </div>
    </form>
  );
}
