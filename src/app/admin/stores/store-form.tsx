"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { createStore, updateStore } from "@/lib/admin/actions";
import type { StoreFormState } from "@/lib/admin/actions";
import type { Store } from "@prisma/client";

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

  return (
    <form action={formAction} className="space-y-5">
      {mode === "edit" && store && (
        <input type="hidden" name="storeId" value={store.id} />
      )}

      {state.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
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
        <label className="mb-1 block text-sm font-medium text-[#15201A]">
          Slug
        </label>
        <input
          name="slug"
          type="text"
          required
          defaultValue={store?.slug ?? ""}
          pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
          className="w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
          placeholder="mama-ngozi"
        />
        {state.fieldErrors?.slug && (
          <p className="mt-1 text-xs text-red-600">{state.fieldErrors.slug}</p>
        )}
        <p className="mt-1 text-xs text-[#55625A]">
          Becomes the subdomain: slug.yourplatform.com
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-[#15201A]">
          Store name
        </label>
        <input
          name="name"
          type="text"
          required
          defaultValue={store?.name ?? ""}
          className="w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
          placeholder="Mama Ngozi African Market"
        />
        {state.fieldErrors?.name && (
          <p className="mt-1 text-xs text-red-600">{state.fieldErrors.name}</p>
        )}
      </div>

      <fieldset className="rounded-lg border border-[#e2e4e9] p-4">
        <legend className="px-2 text-sm font-medium text-[#15201A]">
          Branding
        </legend>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-[#15201A]">
              Theme preset
            </label>
            <select
              name="themePreset"
              defaultValue={store?.themePreset ?? "palm-and-shea"}
              className="w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
            >
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[#15201A]">
              Brand color
            </label>
            <div className="flex items-center gap-2">
              <input
                name="brandColor"
                type="text"
                defaultValue={store?.brandColor ?? ""}
                pattern="#[0-9A-Fa-f]{6}"
                className="flex-1 rounded-md border border-[#e2e4e9] px-3 py-2 font-mono text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
                placeholder="#1F5A43"
              />
            </div>
            {state.fieldErrors?.brandColor && (
              <p className="mt-1 text-xs text-red-600">
                {state.fieldErrors.brandColor}
              </p>
            )}
            <p className="mt-1 text-xs text-[#55625A]">
              Optional. Will be adjusted if it does not meet contrast requirements.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[#15201A]">
              Logo URL
            </label>
            <input
              name="logoUrl"
              type="text"
              defaultValue={store?.logoUrl ?? ""}
              className="w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
              placeholder="/logos/store-logo.svg"
            />
            {state.fieldErrors?.logoUrl && (
              <p className="mt-1 text-xs text-red-600">
                {state.fieldErrors.logoUrl}
              </p>
            )}
          </div>
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-[#e2e4e9] p-4">
        <legend className="px-2 text-sm font-medium text-[#15201A]">
          Settings
        </legend>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-[#15201A]">
              Hours (JSON)
            </label>
            <textarea
              name="hours"
              rows={3}
              defaultValue={
                store?.hours ? JSON.stringify(store.hours, null, 2) : ""
              }
              className="w-full rounded-md border border-[#e2e4e9] px-3 py-2 font-mono text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
              placeholder='{"mon": "9:00-21:00", "tue": "9:00-21:00"}'
            />
            {state.fieldErrors?.hours && (
              <p className="mt-1 text-xs text-red-600">
                {state.fieldErrors.hours}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-[#15201A]">
                Prep time (minutes)
              </label>
              <input
                name="prepTimeMinutes"
                type="number"
                min={1}
                max={480}
                defaultValue={store?.prepTimeMinutes ?? 30}
                className="w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-[#15201A]">
                Delivery radius (miles)
              </label>
              <input
                name="deliveryRadiusMi"
                type="number"
                min={1}
                max={15}
                step={0.5}
                defaultValue={store ? Number(store.deliveryRadiusMi) : 8}
                className="w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-[#15201A]">
                Minimum order ($)
              </label>
              <input
                name="minimumOrder"
                type="number"
                min={0}
                step={0.01}
                defaultValue={store ? store.minimumOrderCents / 100 : 35}
                className="w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
              />
              {state.fieldErrors?.minimumOrder && (
                <p className="mt-1 text-xs text-red-600">
                  {state.fieldErrors.minimumOrder}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-[#15201A]">
                Auto-refund limit ($)
              </label>
              <input
                name="autoRefundLimit"
                type="number"
                min={0}
                step={0.01}
                defaultValue={store ? store.autoRefundLimitCents / 100 : 25}
                className="w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
              />
              {state.fieldErrors?.autoRefundLimit && (
                <p className="mt-1 text-xs text-red-600">
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
              defaultChecked={store?.pickupEnabled ?? false}
              className="h-4 w-4 rounded border-[#e2e4e9] text-[#1F5A43] focus:ring-[#1F5A43]"
            />
            <label htmlFor="pickupEnabled" className="text-sm text-[#15201A]">
              Pickup enabled
            </label>
          </div>

          {mode === "edit" && (
            <div>
              <label className="mb-1 block text-sm font-medium text-[#15201A]">
                Status
              </label>
              <select
                name="status"
                defaultValue={store?.status ?? "active"}
                className="w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
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
          className="rounded-full bg-[#1F5A43] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#123726] disabled:opacity-50"
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
          className="rounded-full border border-[#e2e4e9] px-6 py-2.5 text-sm font-medium text-[#55625A] hover:bg-[#f8f9fa]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
