"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createStore, updateStore } from "@/lib/admin/actions";
import type { StoreFormState } from "@/lib/admin/actions";
import type { Store } from "@prisma/client";
import { VALID_US_TIMEZONES } from "@/lib/admin/timezone";
import { SLOT_FORMS, WEEKDAYS, slotFormValues, slotGapWarning, type SlotFormPrefix } from "@/lib/admin/slot-form";
import { SLUG_INPUT_PATTERN } from "@/lib/slug";
import { displayAddress } from "@/lib/directory/links";
import { HoursEditor } from "@/components/store-hours/hours-editor";
import { DEFAULT_WEEK, readWeeklyHours, writeWeeklyHours, type WeekHours } from "@/lib/store-settings/weekly-hours";

const PRESETS = [
  { value: "palm-and-shea", label: "Palm & Shea" },
  { value: "cocoa-and-bottle-green", label: "Cocoa & Bottle Green" },
  { value: "lagoon-and-coral", label: "Lagoon & Coral" },
];

export function StoreForm({
  mode,
  store,
  webAddress,
}: {
  mode: "create" | "edit";
  store?: Store;
  /** The store's address (edit) or an example one (create), from the request host; null when it cannot be routed. */
  webAddress: string | null;
}) {
  const router = useRouter();
  const action = mode === "create" ? createStore : updateStore;
  const [state, formAction, isPending] = useActionState<StoreFormState, FormData>(
    action,
    {},
  );

  useEffect(() => {
    if (state.success && !state.brandColorNudged) {
      router.push("/admin/stores");
    }
  }, [state.success, state.brandColorNudged, router]);

  const sv = state.submittedValues;

  // The slot settings that would offer nothing in the next 7 days (#807), read from the form as it stands.
  const formRef = useRef<HTMLFormElement>(null);
  const [gaps, setGaps] = useState<Partial<Record<SlotFormPrefix, string>>>({});
  function checkGaps() {
    requestAnimationFrame(() => {
      if (!formRef.current) return;
      const data = new FormData(formRef.current);
      const read = (key: string) => data.get(key)?.toString() ?? null;
      let hours: unknown = null;
      try {
        hours = JSON.parse(read("hours") || "null");
      } catch {}
      const now = new Date();
      const next = Object.fromEntries(SLOT_FORMS.map(({ prefix }) => [prefix, slotGapWarning(read, prefix, hours, read("timezone") ?? "", now) ?? undefined]));
      setGaps((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    });
  }
  useEffect(checkGaps, []);

  return (
    <form ref={formRef} action={formAction} onChange={checkGaps} onClick={checkGaps} className="space-y-5">
      {mode === "edit" && store && (
        <input type="hidden" name="storeId" value={store.id} />
      )}

      {state.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {state.error}
        </div>
      )}

      {state.success && state.brandColorNudged && (
        <div className="rounded-md border border-border bg-muted p-3 text-sm text-foreground">
          The brand color was adjusted to{" "}
          <span
            className="inline-block h-4 w-4 rounded-sm align-text-bottom border border-input"
            style={{ backgroundColor: state.nudgedColor }}
          />{" "}
          <code>{state.nudgedColor}</code> to meet accessibility contrast
          requirements. The store has been saved.{" "}
          <button
            type="button"
            onClick={() => router.push("/admin/stores")}
            className="underline"
          >
            Back to stores
          </button>
        </div>
      )}

      <div>
        <label htmlFor="slug" className="mb-1 block text-sm font-medium text-foreground">
          Slug
        </label>
        <input
          id="slug"
          name="slug"
          type="text"
          required
          defaultValue={sv?.slug ?? store?.slug ?? ""}
          pattern={SLUG_INPUT_PATTERN}
          className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="mama-ngozi"
        />
        {state.fieldErrors?.slug && (
          <p className="mt-1 text-xs text-destructive">{state.fieldErrors.slug}</p>
        )}
        {webAddress && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="slug-address">
            {mode === "create" ? "Becomes the store's web address, like " : "The store's web address: "}
            {displayAddress(webAddress)}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="storeName" className="mb-1 block text-sm font-medium text-foreground">
          Store name
        </label>
        <input
          id="storeName"
          name="name"
          type="text"
          required
          defaultValue={sv?.name ?? store?.name ?? ""}
          className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="Mama Ngozi African Market"
        />
        {state.fieldErrors?.name && (
          <p className="mt-1 text-xs text-destructive">{state.fieldErrors.name}</p>
        )}
      </div>

      <fieldset className="rounded-lg border border-input p-4">
        <legend className="px-2 text-sm font-medium text-foreground">
          Branding
        </legend>
        <div className="space-y-4">
          <div>
            <label htmlFor="themePreset" className="mb-1 block text-sm font-medium text-foreground">
              Theme preset
            </label>
            <select
              id="themePreset"
              name="themePreset"
              defaultValue={sv?.themePreset ?? store?.themePreset ?? "palm-and-shea"}
              className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="brandColor" className="mb-1 block text-sm font-medium text-foreground">
              Brand color
            </label>
            <div className="flex items-center gap-2">
              <input
                id="brandColor"
                name="brandColor"
                type="text"
                defaultValue={sv?.brandColor ?? store?.brandColor ?? ""}
                pattern="#[0-9A-Fa-f]{6}"
                className="flex-1 rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground font-mono text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="#1F5A43"
              />
            </div>
            {state.fieldErrors?.brandColor && (
              <p className="mt-1 text-xs text-destructive">
                {state.fieldErrors.brandColor}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Optional. Will be adjusted if it does not meet contrast requirements.
            </p>
          </div>

          <div>
            <label htmlFor="logoUrl" className="mb-1 block text-sm font-medium text-foreground">
              Logo URL
            </label>
            <input
              id="logoUrl"
              name="logoUrl"
              type="text"
              defaultValue={sv?.logoUrl ?? store?.logoUrl ?? ""}
              className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="/logos/store-logo.svg"
            />
            {state.fieldErrors?.logoUrl && (
              <p className="mt-1 text-xs text-destructive">
                {state.fieldErrors.logoUrl}
              </p>
            )}
          </div>
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-input p-4">
        <legend className="px-2 text-sm font-medium text-foreground">
          Settings
        </legend>
        <div className="space-y-4">
          <HoursField saved={sv?.hours ?? store?.hours ?? null} error={state.fieldErrors?.hours} />

          <div>
            <label htmlFor="timezone" className="mb-1 block text-sm font-medium text-foreground">
              Timezone
            </label>
            <select
              id="timezone"
              name="timezone"
              defaultValue={sv?.timezone ?? store?.timezone ?? "America/New_York"}
              className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {VALID_US_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            {state.fieldErrors?.timezone && (
              <p className="mt-1 text-xs text-destructive">
                {state.fieldErrors.timezone}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="prepTimeMinutes" className="mb-1 block text-sm font-medium text-foreground">
                Prep time (minutes)
              </label>
              <input
                id="prepTimeMinutes"
                name="prepTimeMinutes"
                type="number"
                min={0}
                max={480}
                defaultValue={sv?.prepTimeMinutes ?? store?.prepTimeMinutes ?? 30}
                className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div>
              <label htmlFor="deliveryRadiusMi" className="mb-1 block text-sm font-medium text-foreground">
                Delivery radius (miles)
              </label>
              <input
                id="deliveryRadiusMi"
                name="deliveryRadiusMi"
                type="number"
                min={0}
                max={15}
                step={0.5}
                defaultValue={sv?.deliveryRadiusMi ?? (store ? Number(store.deliveryRadiusMi) : 8)}
                className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {state.fieldErrors?.deliveryRadiusMi && (
                <p className="mt-1 text-xs text-destructive">{state.fieldErrors.deliveryRadiusMi}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="addressLine1" className="mb-1 block text-sm font-medium text-foreground">
                Street address
              </label>
              <input
                id="addressLine1"
                name="addressLine1"
                maxLength={120}
                defaultValue={sv?.addressLine1 ?? store?.addressLine1 ?? ""}
                className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {state.fieldErrors?.addressLine1 && (
                <p className="mt-1 text-xs text-destructive">{state.fieldErrors.addressLine1}</p>
              )}
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="addressLine2" className="mb-1 block text-sm font-medium text-foreground">
                Apartment, suite (optional)
              </label>
              <input
                id="addressLine2"
                name="addressLine2"
                maxLength={120}
                defaultValue={sv?.addressLine2 ?? store?.addressLine2 ?? ""}
                className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div>
              <label htmlFor="city" className="mb-1 block text-sm font-medium text-foreground">City</label>
              <input
                id="city"
                name="city"
                maxLength={80}
                defaultValue={sv?.city ?? store?.city ?? ""}
                className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="state" className="mb-1 block text-sm font-medium text-foreground">State</label>
                <input
                  id="state"
                  name="state"
                  maxLength={2}
                  defaultValue={sv?.state ?? store?.state ?? ""}
                  className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm uppercase focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                {state.fieldErrors?.state && (
                  <p className="mt-1 text-xs text-destructive">{state.fieldErrors.state}</p>
                )}
              </div>
              <div>
                <label htmlFor="zip" className="mb-1 block text-sm font-medium text-foreground">ZIP</label>
                <input
                  id="zip"
                  name="zip"
                  inputMode="numeric"
                  maxLength={5}
                  defaultValue={sv?.zip ?? store?.zip ?? ""}
                  className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                {state.fieldErrors?.zip && (
                  <p className="mt-1 text-xs text-destructive">{state.fieldErrors.zip}</p>
                )}
              </div>
            </div>
            <div>
              <label htmlFor="phone" className="mb-1 block text-sm font-medium text-foreground">Store phone</label>
              <input
                id="phone"
                name="phone"
                type="tel"
                autoComplete="tel"
                maxLength={40}
                defaultValue={sv?.phone ?? store?.phone ?? ""}
                aria-describedby="phone-help"
                className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <p id="phone-help" className="mt-1 text-xs text-muted-foreground">Couriers call this number at pickup. Courier delivery needs it.</p>
              {state.fieldErrors?.phone && (
                <p className="mt-1 text-xs text-destructive">{state.fieldErrors.phone}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              name="storeDeliveryEnabled"
              type="checkbox"
              id="storeDeliveryEnabled"
              defaultChecked={sv ? sv.storeDeliveryEnabled === "on" : (store?.storeDeliveryEnabled ?? false)}
              className="h-4 w-4 rounded border-input text-primary focus-visible:ring-ring"
            />
            <label htmlFor="storeDeliveryEnabled" className="text-sm text-foreground">
              Store delivery
            </label>
          </div>
          <div>
            <label htmlFor="storeDeliveryFee" className="mb-1 block text-sm font-medium text-foreground">
              Store delivery fee ($)
            </label>
            <input
              id="storeDeliveryFee"
              name="storeDeliveryFee"
              type="number"
              min={0}
              max={100}
              step={0.01}
              defaultValue={sv?.storeDeliveryFee ?? (store ? store.storeDeliveryFeeCents / 100 : 0)}
              className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {state.fieldErrors?.storeDeliveryFee && (
              <p className="mt-1 text-xs text-destructive">{state.fieldErrors.storeDeliveryFee}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="minimumOrder" className="mb-1 block text-sm font-medium text-foreground">
                Minimum order ($)
              </label>
              <input
                id="minimumOrder"
                name="minimumOrder"
                type="number"
                min={0}
                step={0.01}
                defaultValue={sv?.minimumOrder ?? (store ? store.minimumOrderCents / 100 : 35)}
                className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {state.fieldErrors?.minimumOrder && (
                <p className="mt-1 text-xs text-destructive">
                  {state.fieldErrors.minimumOrder}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="autoRefundLimit" className="mb-1 block text-sm font-medium text-foreground">
                Auto-refund limit ($)
              </label>
              <input
                id="autoRefundLimit"
                name="autoRefundLimit"
                type="number"
                min={0}
                step={0.01}
                defaultValue={sv?.autoRefundLimit ?? (store ? store.autoRefundLimitCents / 100 : 25)}
                className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {state.fieldErrors?.autoRefundLimit && (
                <p className="mt-1 text-xs text-destructive">
                  {state.fieldErrors.autoRefundLimit}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="supportSlaMinutes" className="mb-1 block text-sm font-medium text-foreground">
                Message reply time (open minutes)
              </label>
              <input
                id="supportSlaMinutes"
                name="supportSlaMinutes"
                type="number"
                min={1}
                max={1440}
                defaultValue={sv?.supportSlaMinutes ?? store?.supportSlaMinutes ?? 30}
                aria-describedby="supportSlaMinutes-hint"
                className="w-full rounded-md border border-input px-3 py-2 placeholder:text-muted-foreground text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <p id="supportSlaMinutes-hint" className="mt-1 text-xs text-muted-foreground">
                An unanswered customer message goes to the platform team after this many open minutes.
              </p>
              {state.fieldErrors?.supportSlaMinutes && (
                <p className="mt-1 text-xs text-destructive">
                  {state.fieldErrors.supportSlaMinutes}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              name="pickupEnabled"
              type="checkbox"
              id="pickupEnabled"
              defaultChecked={sv ? sv.pickupEnabled === "on" : (store?.pickupEnabled ?? false)}
              className="h-4 w-4 rounded border-input text-primary focus-visible:ring-ring"
            />
            <label htmlFor="pickupEnabled" className="text-sm text-foreground">
              Pickup enabled
            </label>
          </div>

        </div>
      </fieldset>

      {mode === "edit" && store && (
        <fieldset className="rounded-lg border border-input p-4">
          <legend className="px-2 text-sm font-medium text-foreground">Store directory</legend>
          <div className="flex items-center gap-2">
            <input
              name="listed"
              type="checkbox"
              id="listed"
              defaultChecked={sv ? sv.listed === "on" : store.listed}
              aria-describedby="listed-hint"
              className="h-4 w-4 rounded border-input text-primary focus-visible:ring-ring"
            />
            <label htmlFor="listed" className="text-sm text-foreground">
              Listed in the directory
            </label>
          </div>
          <p id="listed-hint" className="mt-1 text-xs text-muted-foreground">
            The owner sets this in their store admin. Change it here only to override them.
          </p>
        </fieldset>
      )}

      <fieldset className="rounded-lg border border-input p-4">
        <legend className="px-2 text-sm font-medium text-foreground">Scheduled slots</legend>
        <p className="mb-4 text-sm text-muted-foreground">
          Times customers can book at checkout, in the store&apos;s timezone. Without slots, pickup offers
          today&apos;s half hours and store delivery stays as soon as possible.
        </p>
        <div className="space-y-6">
          {SLOT_FORMS.map((form) => (
            <SlotFields
              key={form.prefix}
              prefix={form.prefix}
              title={form.title}
              values={sv ?? slotFormValues(store?.[form.column] ?? null, form.prefix)}
              errors={state.fieldErrors ?? {}}
              warning={gaps[form.prefix]}
            />
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isPending
            ? mode === "create"
              ? "Creating..."
              : "Saving..."
            : mode === "create"
              ? "Create store"
              : "Save changes"}
        </button>
        <button
          type="button"
          onClick={() => router.push("/admin/stores")}
          className="rounded-full border border-input px-6 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

const FIELD = "w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const LABEL = "mb-1 block text-sm font-medium text-foreground";

function SlotFields({
  prefix,
  title,
  values,
  errors,
  warning,
}: {
  prefix: SlotFormPrefix;
  title: string;
  values: Record<string, string>;
  errors: Record<string, string>;
  warning?: string;
}) {
  const error = (suffix: string) =>
    errors[`${prefix}${suffix}`] ? (
      <p className="mt-1 text-xs text-destructive">{errors[`${prefix}${suffix}`]}</p>
    ) : null;
  const numbers = [
    { suffix: "Minutes", label: "Slot length (minutes)", min: 15, max: 240, step: 15 },
    { suffix: "Lead", label: "Lead time (minutes)", min: 120, max: 2880, step: 15 },
    { suffix: "Capacity", label: "Orders per slot", min: 1, max: 500, step: 1 },
    { suffix: "DaysAhead", label: "Days ahead (1-5)", min: 1, max: 5, step: 1 },
  ];
  return (
    <section aria-labelledby={`${prefix}-title`} className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          name={`${prefix}Enabled`}
          type="checkbox"
          id={`${prefix}Enabled`}
          defaultChecked={values[`${prefix}Enabled`] === "on"}
          className="h-4 w-4 rounded border-input text-primary focus-visible:ring-ring"
        />
        <label id={`${prefix}-title`} htmlFor={`${prefix}Enabled`} className="text-sm font-medium text-foreground">
          {title}
        </label>
      </div>
      {error("Enabled")}
      {warning && (
        <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm text-foreground">{warning}</p>
      )}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {numbers.map((field) => (
          <div key={field.suffix}>
            <label htmlFor={`${prefix}${field.suffix}`} className={LABEL}>{field.label}</label>
            <input
              id={`${prefix}${field.suffix}`}
              name={`${prefix}${field.suffix}`}
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              defaultValue={values[`${prefix}${field.suffix}`] ?? ""}
              className={FIELD}
            />
            {error(field.suffix)}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {WEEKDAYS.map((day) => (
          <div key={day}>
            <label htmlFor={`${prefix}${day}`} className={LABEL}>{day} windows</label>
            <input
              id={`${prefix}${day}`}
              name={`${prefix}${day}`}
              type="text"
              placeholder="9:00 AM - 12:00 PM, 2:00 PM - 6:00 PM"
              defaultValue={values[`${prefix}${day}`] ?? ""}
              className={FIELD}
            />
            {error(day)}
          </div>
        ))}
      </div>
      <div>
        <label htmlFor={`${prefix}Closed`} className={LABEL}>Closed dates</label>
        <input
          id={`${prefix}Closed`}
          name={`${prefix}Closed`}
          type="text"
          placeholder="2026-12-25, 2027-01-01"
          defaultValue={values[`${prefix}Closed`] ?? ""}
          className={FIELD}
        />
        {error("Closed")}
      </div>
    </section>
  );
}

/** The weekly hours editor (#786), posted as the same JSON the store action has always read. */
function HoursField({ saved, error }: { saved: unknown; error?: string }) {
  const [initial] = useState(() => {
    if (typeof saved !== "string") return readWeeklyHours(saved);
    try {
      return readWeeklyHours(JSON.parse(saved));
    } catch {
      return null;
    }
  });
  const [week, setWeek] = useState<WeekHours | null>(initial?.week ?? null);

  return (
    <fieldset>
      <legend className="mb-1 block text-sm font-medium text-foreground">Hours</legend>
      <input type="hidden" name="hours" value={week ? JSON.stringify(writeWeeklyHours(week)) : ""} />
      {week ? (
        <HoursEditor week={week} onChange={setWeek} unreadable={initial?.unreadable} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">No hours set: checkout treats the store as always open.</p>
          <button
            type="button"
            onClick={() => setWeek(DEFAULT_WEEK)}
            className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4"
          >
            Set weekly hours
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </fieldset>
  );
}
