"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { createStore, updateStore } from "@/lib/admin/actions";
import type { StoreFormState } from "@/lib/admin/actions";
import type { Store } from "@prisma/client";
import { VALID_US_TIMEZONES } from "@/lib/admin/timezone";

const PRESETS = [
  { value: "palm-and-shea", label: "Palm & Shea" },
  { value: "cocoa-and-bottle-green", label: "Cocoa & Bottle Green" },
  { value: "lagoon-and-coral", label: "Lagoon & Coral" },
];

export function StoreForm({
  mode,
  store,
}: {
  mode: "create" | "edit";
  store?: Store;
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

  return (
    <form action={formAction} className="space-y-5">
      {mode === "edit" && store && (
        <input type="hidden" name="storeId" value={store.id} />
      )}

      {state.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {state.error}
        </div>
      )}

      {state.success && state.brandColorNudged && (
        <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
          The brand color was adjusted to{" "}
          <span
            className="inline-block h-4 w-4 rounded-sm align-text-bottom border border-amber-200"
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
          pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
          className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="mama-ngozi"
        />
        {state.fieldErrors?.slug && (
          <p className="mt-1 text-xs text-destructive">{state.fieldErrors.slug}</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Becomes the subdomain: slug.yourplatform.com
        </p>
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
          className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
              className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                className="flex-1 rounded-md border border-input px-3 py-2 font-mono text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
              className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
          <div>
            <label htmlFor="hours" className="mb-1 block text-sm font-medium text-foreground">
              Hours (JSON)
            </label>
            <textarea
              id="hours"
              name="hours"
              rows={3}
              defaultValue={
                sv?.hours ?? (store?.hours ? JSON.stringify(store.hours, null, 2) : "")
              }
              className="w-full rounded-md border border-input px-3 py-2 font-mono text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder='{"mon": "9:00-21:00", "tue": "9:00-21:00"}'
            />
            {state.fieldErrors?.hours && (
              <p className="mt-1 text-xs text-destructive">
                {state.fieldErrors.hours}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="timezone" className="mb-1 block text-sm font-medium text-foreground">
              Timezone
            </label>
            <select
              id="timezone"
              name="timezone"
              defaultValue={sv?.timezone ?? store?.timezone ?? "America/New_York"}
              className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div>
              <label htmlFor="city" className="mb-1 block text-sm font-medium text-foreground">City</label>
              <input
                id="city"
                name="city"
                maxLength={80}
                defaultValue={sv?.city ?? store?.city ?? ""}
                className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                  className="w-full rounded-md border border-input px-3 py-2 text-sm uppercase focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                  className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                {state.fieldErrors?.zip && (
                  <p className="mt-1 text-xs text-destructive">{state.fieldErrors.zip}</p>
                )}
              </div>
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
              className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {state.fieldErrors?.autoRefundLimit && (
                <p className="mt-1 text-xs text-destructive">
                  {state.fieldErrors.autoRefundLimit}
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

          {mode === "edit" && (
            <div>
              <label htmlFor="status" className="mb-1 block text-sm font-medium text-foreground">
                Status
              </label>
              <select
                id="status"
                name="status"
                defaultValue={sv?.status ?? store?.status ?? "active"}
                className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
              </select>
            </div>
          )}

          {mode === "create" && <input type="hidden" name="status" value="active" />}
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
