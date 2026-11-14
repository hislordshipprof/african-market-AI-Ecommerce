"use server";

import { revalidateStore } from "../get-store";
import { platformAdmin, platformAdminTransaction, lockStoreAddress } from "../db";
import { requirePlatformAdmin } from "./session";
import { nudgeForContrast, getThemeTokens, VALID_PRESETS } from "../theme";
import { isSlugRoutable } from "../slug";
import type { ThemePreset } from "../theme";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { createInvite } from "../invite/service";
import { resolveAuthBaseUrl } from "../auth";
import { parseInput, readFormField, readFormFields } from "../security/parse-input";
import { getAddressProvider } from "../address/provider";
import { setPilot } from "../billing/service";
import { hasFullAddress, requestCourierRegistration } from "../delivery/courier-registration";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { VALID_US_TIMEZONES } from "./timezone";

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const MAX_CENTS = 2_147_483_647;

function parseFloatOrDefault(raw: string | null | undefined, defaultValue: number): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return defaultValue;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return NaN;
  return n;
}

function parseIntOrDefault(raw: string | null | undefined, defaultValue: number): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return defaultValue;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return NaN;
  return n;
}

export type StoreFormState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  submittedValues?: Record<string, string>;
  success?: boolean;
  storeId?: string;
  brandColorNudged?: boolean;
  nudgedColor?: string;
};

function formText(data: unknown, key: string): string | null {
  const value = readFormField(data, key);
  return typeof value === "string" ? value : null;
}

function extractRawValues(data: FormData): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const key of ["slug", "name", "logoUrl", "brandColor", "themePreset", "status", "hours", "prepTimeMinutes", "deliveryRadiusMi", "minimumOrder", "autoRefundLimit", "supportSlaMinutes", "pickupEnabled", "timezone", "addressLine1", "addressLine2", "city", "state", "zip", "storeDeliveryFee", "storeDeliveryEnabled"]) {
    const v = formText(data, key);
    if (v != null) raw[key] = v;
  }
  return raw;
}

function validateStoreFields(data: FormData, defaultTimezone = "America/New_York"): {
  errors: Record<string, string>;
  values: {
    slug: string;
    name: string;
    logoUrl: string | null;
    brandColor: string | null;
    themePreset: string;
    status: string;
    hours: unknown;
    prepTimeMinutes: number;
    deliveryRadiusMi: number;
    minimumOrderCents: number;
    pickupEnabled: boolean;
    autoRefundLimitCents: number;
    supportSlaMinutes: number;
    timezone: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    storeDeliveryEnabled: boolean;
    storeDeliveryFeeCents: number;
  };
} {
  const errors: Record<string, string> = {};

  const slug = formText(data, "slug")?.trim().toLowerCase() ?? "";
  const name = formText(data, "name")?.trim() ?? "";
  const logoUrl = formText(data, "logoUrl")?.trim() || null;
  const brandColor = formText(data, "brandColor")?.trim() || null;
  const themePreset = formText(data, "themePreset")?.trim() || "palm-and-shea";
  const status = formText(data, "status")?.trim() || "active";
  const hoursRaw = formText(data, "hours")?.trim() || "";
  const prepTimeMinutes = parseIntOrDefault(formText(data, "prepTimeMinutes"), 30);
  const deliveryRadiusMi = parseFloatOrDefault(formText(data, "deliveryRadiusMi"), 8);
  const minimumOrderCents = Math.round(
    parseFloatOrDefault(formText(data, "minimumOrder"), 35) * 100,
  );
  const pickupEnabled = formText(data, "pickupEnabled") === "on";
  const autoRefundLimitCents = Math.round(
    parseFloatOrDefault(formText(data, "autoRefundLimit"), 25) * 100,
  );
  const supportSlaMinutes = parseIntOrDefault(formText(data, "supportSlaMinutes"), 30);
  const timezone = formText(data, "timezone")?.trim() || defaultTimezone;
  const addressLine1 = formText(data, "addressLine1")?.trim() || null;
  const addressLine2 = formText(data, "addressLine2")?.trim() || null;
  const city = formText(data, "city")?.trim() || null;
  const state = formText(data, "state")?.trim().toUpperCase() || null;
  const zip = formText(data, "zip")?.trim() || null;
  const storeDeliveryEnabled = formText(data, "storeDeliveryEnabled") === "on";
  const storeDeliveryFeeCents = Math.round(parseFloatOrDefault(formText(data, "storeDeliveryFee"), 0) * 100);

  if (!slug) errors.slug = "Slug is required";
  else if (!isSlugRoutable(slug)) errors.slug = "This slug is not allowed (reserved, all-digit, or invalid format)";

  if (logoUrl) {
    if (logoUrl.startsWith("/") && !logoUrl.startsWith("//")) {
      // local path — always allowed
    } else if (logoUrl.startsWith("//")) {
      errors.logoUrl = "Protocol-relative URLs are not allowed; use a local path like /logos/store-logo.svg";
    } else {
      try {
        const parsed = new URL(logoUrl);
        if (parsed.protocol !== "https:") {
          errors.logoUrl = "Logo URL must use HTTPS or be a local path";
        } else {
          const allowedHosts = (process.env.LOGO_HOSTS ?? "")
            .split(",")
            .map((h) => h.trim())
            .filter(Boolean);
          if (allowedHosts.length === 0) {
            errors.logoUrl = "Remote logo URLs are not allowed until LOGO_HOSTS is configured; use a local path like /logos/store-logo.svg";
          } else if (!allowedHosts.includes(parsed.hostname)) {
            errors.logoUrl = `Logo host '${parsed.hostname}' is not in the allowed list`;
          }
        }
      } catch {
        errors.logoUrl = "Logo URL must be a valid URL or a local path starting with /";
      }
    }
  }

  if (!name) errors.name = "Name is required";

  if (brandColor && !HEX_COLOR_RE.test(brandColor)) {
    errors.brandColor = "Brand color must be a valid hex color (e.g. #1F5A43)";
  }

  if (!(VALID_PRESETS as readonly string[]).includes(themePreset)) {
    errors.themePreset = "Invalid theme preset";
  }

  if (!["active", "suspended"].includes(status)) {
    errors.status = "Status must be active or suspended";
  }

  if (!Number.isFinite(prepTimeMinutes) || prepTimeMinutes < 0 || prepTimeMinutes > 480) {
    errors.prepTimeMinutes = "Prep time must be 0-480 minutes";
  }

  if (!Number.isFinite(deliveryRadiusMi) || deliveryRadiusMi < 0 || deliveryRadiusMi > 15) {
    errors.deliveryRadiusMi = "Delivery radius must be 0-15 miles";
  }

  if (!Number.isFinite(minimumOrderCents) || minimumOrderCents < 0) {
    errors.minimumOrder = "Minimum order must be a non-negative number";
  } else if (minimumOrderCents > MAX_CENTS) {
    errors.minimumOrder = "Minimum order is too large";
  }

  if (!Number.isFinite(autoRefundLimitCents) || autoRefundLimitCents < 0) {
    errors.autoRefundLimit = "Auto-refund limit must be a non-negative number";
  } else if (autoRefundLimitCents > MAX_CENTS) {
    errors.autoRefundLimit = "Auto-refund limit is too large";
  }

  if (!Number.isFinite(supportSlaMinutes) || supportSlaMinutes < 1 || supportSlaMinutes > 1440) {
    errors.supportSlaMinutes = "Message reply time must be 1-1440 open minutes";
  }

  if (!(VALID_US_TIMEZONES as readonly string[]).includes(timezone)) {
    errors.timezone = `Invalid timezone: must be one of ${VALID_US_TIMEZONES.join(", ")}`;
  }

  if (state && !/^[A-Z]{2}$/.test(state)) errors.state = "State must be a 2-letter code";
  if (zip && !/^\d{5}$/.test(zip)) errors.zip = "ZIP must be 5 digits";
  if (!Number.isFinite(storeDeliveryFeeCents) || storeDeliveryFeeCents < 0 || storeDeliveryFeeCents > 10_000) {
    errors.storeDeliveryFee = "Delivery fee must be $0–$100";
  }
  if (storeDeliveryEnabled) {
    if (!addressLine1 || !city || !state || !zip) {
      errors.addressLine1 = "Store delivery needs a street, city, state, and ZIP";
    }
    if (deliveryRadiusMi <= 0) errors.deliveryRadiusMi = "Delivery radius must be greater than 0";
  }

  let hours: unknown = null;
  if (hoursRaw) {
    try {
      hours = JSON.parse(hoursRaw);
    } catch {
      errors.hours = "Hours must be valid JSON";
    }
  }

  return {
    errors,
    values: {
      slug,
      name,
      logoUrl,
      brandColor,
      themePreset,
      status,
      hours,
      prepTimeMinutes,
      deliveryRadiusMi,
      minimumOrderCents,
      pickupEnabled,
      autoRefundLimitCents,
      supportSlaMinutes,
      timezone,
      addressLine1,
      addressLine2,
      city,
      state,
      zip,
      storeDeliveryEnabled,
      storeDeliveryFeeCents,
    },
  };
}

const STORE_FORM_FIELDS = [
  "slug", "name", "logoUrl", "brandColor", "themePreset", "status", "hours",
  "prepTimeMinutes", "deliveryRadiusMi", "minimumOrder", "autoRefundLimit", "supportSlaMinutes",
  "pickupEnabled", "timezone", "storeId",
  "addressLine1", "addressLine2", "city", "state", "zip",
  "storeDeliveryFee", "storeDeliveryEnabled",
] as const;
const storeFormSchema = z.strictObject({
  slug: z.string().max(80).nullable(),
  name: z.string().max(200).nullable(),
  logoUrl: z.string().max(2_000).nullable(),
  brandColor: z.string().max(32).nullable(),
  themePreset: z.string().max(40).nullable(),
  status: z.string().max(20).nullable(),
  hours: z.string().max(20_000).nullable(),
  prepTimeMinutes: z.string().max(20).nullable(),
  deliveryRadiusMi: z.string().max(20).nullable(),
  minimumOrder: z.string().max(20).nullable(),
  autoRefundLimit: z.string().max(20).nullable(),
  supportSlaMinutes: z.string().max(20).nullable(),
  pickupEnabled: z.string().max(10).nullable(),
  timezone: z.string().max(80).nullable(),
  storeId: z.string().max(200).nullable(),
  addressLine1: z.string().max(120).nullable(),
  addressLine2: z.string().max(120).nullable(),
  city: z.string().max(80).nullable(),
  state: z.string().max(8).nullable(),
  zip: z.string().max(12).nullable(),
  storeDeliveryFee: z.string().max(20).nullable(),
  storeDeliveryEnabled: z.string().max(10).nullable(),
});

function boundStoreForm(data: FormData): boolean {
  return parseInput(storeFormSchema, readFormFields(data, STORE_FORM_FIELDS)).ok;
}

function addressStamp(row: {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}): string {
  return [row.addressLine1, row.addressLine2, row.city, row.state, row.zip]
    .map((part) => (part ?? "").trim().toLowerCase())
    .join("|");
}

class StoreAddressChanged extends Error {
  constructor() {
    super("STORE_ADDRESS_CHANGED");
  }
}

async function coordinatesForStore(
  values: {
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    addressLine2: string | null;
    storeDeliveryEnabled: boolean;
  },
  previous: {
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    lat: number | null;
    lng: number | null;
  } | null,
): Promise<{ lat: number | null; lng: number | null } | { error: string }> {
  if (
    previous &&
    previous.lat != null &&
    previous.lng != null &&
    addressStamp(values) === addressStamp(previous)
  ) {
    return { lat: previous.lat, lng: previous.lng };
  }
  if (!values.addressLine1) return { lat: null, lng: null };
  const located = await getAddressProvider().locate({
    line1: values.addressLine1,
    city: values.city ?? "",
    state: values.state ?? "",
    zip: values.zip ?? "",
  });
  if (!located.ok) {
    if (values.storeDeliveryEnabled) return { error: "We couldn't confirm that address" };
    return { lat: null, lng: null };
  }
  return { lat: located.match.lat, lng: located.match.lng };
}

function deliveryAudit(row: {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  storeDeliveryEnabled: boolean;
  storeDeliveryFeeCents: number;
}) {
  return {
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    lat: row.lat,
    lng: row.lng,
    storeDeliveryEnabled: row.storeDeliveryEnabled,
    storeDeliveryFeeCents: row.storeDeliveryFeeCents,
  };
}

/** Spec §6.1 step 5, run when the platform admin saves a store with its full address. */
async function queueCourierRegistration(store: {
  id: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  uberLocationId: string | null;
  doordashStoreId: string | null;
}): Promise<void> {
  if (!hasFullAddress(store) || (store.uberLocationId && store.doordashStoreId)) return;
  await requestCourierRegistration(store.id);
}

export async function createStore(
  _prev: StoreFormState,
  data: FormData,
): Promise<StoreFormState> {
  const session = await requirePlatformAdmin();
  if (!boundStoreForm(data)) {
    return { fieldErrors: { hours: "Hours must be valid JSON" }, submittedValues: extractRawValues(data) };
  }

  const raw = extractRawValues(data);
  const { errors, values } = validateStoreFields(data);
  if (Object.keys(errors).length > 0) {
    return { fieldErrors: errors, submittedValues: raw };
  }

  const existing = await platformAdmin.store.findUnique({
    where: { slug: values.slug },
  });
  if (existing) {
    return { fieldErrors: { slug: "A store with this slug already exists" }, submittedValues: raw };
  }

  const coords = await coordinatesForStore(values, null);
  if ("error" in coords) {
    return { fieldErrors: { addressLine1: coords.error }, submittedValues: raw };
  }
  if (values.storeDeliveryEnabled && (coords.lat == null || coords.lng == null)) {
    return { fieldErrors: { addressLine1: "Store delivery needs a confirmed address" }, submittedValues: raw };
  }

  let brandColorNudged = false;
  let nudgedColor: string | undefined;
  let finalBrandColor = values.brandColor;
  if (finalBrandColor) {
    const tokens = getThemeTokens(values.themePreset as ThemePreset);
    const result = nudgeForContrast(finalBrandColor, tokens.bg);
    if (result.nudged) {
      brandColorNudged = true;
      nudgedColor = result.color;
      finalBrandColor = result.color;
    }
  }

  const store = await platformAdminTransaction(async (tx) => {
    const s = await tx.store.create({
      data: {
        slug: values.slug,
        name: values.name,
        logoUrl: values.logoUrl,
        brandColor: finalBrandColor,
        themePreset: values.themePreset,
        status: values.status,
        hours: values.hours !== null ? values.hours : Prisma.JsonNull,
        prepTimeMinutes: values.prepTimeMinutes,
        deliveryRadiusMi: values.deliveryRadiusMi,
        minimumOrderCents: values.minimumOrderCents,
        pickupEnabled: values.pickupEnabled,
        autoRefundLimitCents: values.autoRefundLimitCents,
        supportSlaMinutes: values.supportSlaMinutes,
        timezone: values.timezone,
        addressLine1: values.addressLine1,
        addressLine2: values.addressLine2,
        city: values.city,
        state: values.state,
        zip: values.zip,
        lat: coords.lat,
        lng: coords.lng,
        storeDeliveryEnabled: values.storeDeliveryEnabled,
        storeDeliveryFeeCents: values.storeDeliveryFeeCents,
      },
    });

    await tx.auditLog.create({
      data: {
        storeId: s.id,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "store.create",
        entityType: "store",
        entityId: s.id,
        after: {
          slug: s.slug,
          name: s.name,
          logoUrl: s.logoUrl,
          brandColor: s.brandColor,
          themePreset: s.themePreset,
          status: s.status,
          hours: s.hours,
          prepTimeMinutes: s.prepTimeMinutes,
          deliveryRadiusMi: Number(s.deliveryRadiusMi),
          minimumOrderCents: s.minimumOrderCents,
          pickupEnabled: s.pickupEnabled,
          autoRefundLimitCents: s.autoRefundLimitCents,
          supportSlaMinutes: s.supportSlaMinutes,
          timezone: s.timezone,
          ...deliveryAudit(s),
        },
      },
    });

    return s;
  });

  revalidateStore(store);
  await queueCourierRegistration(store);

  return {
    success: true,
    storeId: store.id,
    brandColorNudged,
    nudgedColor,
  };
}

export async function updateStore(
  _prev: StoreFormState,
  data: FormData,
): Promise<StoreFormState> {
  const session = await requirePlatformAdmin();
  if (!boundStoreForm(data)) return { error: "Store ID is required" };

  const storeId = formText(data, "storeId") ?? "";
  if (!storeId) return { error: "Store ID is required" };

  const before = await platformAdmin.store.findUnique({
    where: { id: storeId },
  });
  if (!before) return { error: "Store not found" };

  const raw = extractRawValues(data);
  const { errors, values } = validateStoreFields(data, before.timezone);
  if (Object.keys(errors).length > 0) {
    return { fieldErrors: errors, submittedValues: raw };
  }

  if (values.slug !== before.slug) {
    const slugTaken = await platformAdmin.store.findUnique({
      where: { slug: values.slug },
    });
    if (slugTaken && slugTaken.id !== storeId) {
      return { fieldErrors: { slug: "A store with this slug already exists" }, submittedValues: raw };
    }
  }

  const coords = await coordinatesForStore(values, before);
  if ("error" in coords) {
    return { fieldErrors: { addressLine1: coords.error }, submittedValues: raw };
  }
  if (values.storeDeliveryEnabled && (coords.lat == null || coords.lng == null)) {
    return { fieldErrors: { addressLine1: "Store delivery needs a confirmed address" }, submittedValues: raw };
  }

  let brandColorNudged = false;
  let nudgedColor: string | undefined;
  let finalBrandColor = values.brandColor;
  if (finalBrandColor) {
    const tokens = getThemeTokens(values.themePreset as ThemePreset);
    const result = nudgeForContrast(finalBrandColor, tokens.bg);
    if (result.nudged) {
      brandColorNudged = true;
      nudgedColor = result.color;
      finalBrandColor = result.color;
    }
  }

  let store;
  try {
    store = await platformAdminTransaction(async (tx) => {
    const lockedAddress = await lockStoreAddress(tx, storeId);
    if (!lockedAddress) throw new Error("Store not found");
    if (addressStamp(lockedAddress) !== addressStamp(before)) {
      throw new StoreAddressChanged();
    }
    const s = await tx.store.update({
      where: { id: storeId },
      data: {
        slug: values.slug,
        name: values.name,
        logoUrl: values.logoUrl,
        brandColor: finalBrandColor,
        themePreset: values.themePreset,
        status: values.status,
        hours: values.hours !== null ? values.hours : Prisma.JsonNull,
        prepTimeMinutes: values.prepTimeMinutes,
        deliveryRadiusMi: values.deliveryRadiusMi,
        minimumOrderCents: values.minimumOrderCents,
        pickupEnabled: values.pickupEnabled,
        autoRefundLimitCents: values.autoRefundLimitCents,
        supportSlaMinutes: values.supportSlaMinutes,
        timezone: values.timezone,
        addressLine1: values.addressLine1,
        addressLine2: values.addressLine2,
        city: values.city,
        state: values.state,
        zip: values.zip,
        lat: coords.lat,
        lng: coords.lng,
        storeDeliveryEnabled: values.storeDeliveryEnabled,
        storeDeliveryFeeCents: values.storeDeliveryFeeCents,
      },
    });

    await tx.auditLog.create({
      data: {
        storeId: s.id,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "store.update",
        entityType: "store",
        entityId: s.id,
        before: {
          slug: before.slug,
          name: before.name,
          logoUrl: before.logoUrl,
          brandColor: before.brandColor,
          themePreset: before.themePreset,
          status: before.status,
          hours: before.hours,
          prepTimeMinutes: before.prepTimeMinutes,
          deliveryRadiusMi: Number(before.deliveryRadiusMi),
          minimumOrderCents: before.minimumOrderCents,
          pickupEnabled: before.pickupEnabled,
          autoRefundLimitCents: before.autoRefundLimitCents,
          supportSlaMinutes: before.supportSlaMinutes,
          timezone: before.timezone,
          ...deliveryAudit(before),
        },
        after: {
          slug: s.slug,
          name: s.name,
          logoUrl: s.logoUrl,
          brandColor: s.brandColor,
          themePreset: s.themePreset,
          status: s.status,
          hours: s.hours,
          prepTimeMinutes: s.prepTimeMinutes,
          deliveryRadiusMi: Number(s.deliveryRadiusMi),
          minimumOrderCents: s.minimumOrderCents,
          pickupEnabled: s.pickupEnabled,
          autoRefundLimitCents: s.autoRefundLimitCents,
          supportSlaMinutes: s.supportSlaMinutes,
          timezone: s.timezone,
          ...deliveryAudit(s),
        },
      },
    });

    return s;
  });
  } catch (error) {
    if (error instanceof StoreAddressChanged) {
      return { fieldErrors: { addressLine1: "This address was just changed. Review it and save again." }, submittedValues: raw };
    }
    throw error;
  }

  revalidateStore(store);
  if (before.slug !== store.slug) {
    revalidateStore({ id: before.id, slug: before.slug });
  }
  await queueCourierRegistration(store);

  return {
    success: true,
    storeId: store.id,
    brandColorNudged,
    nudgedColor,
  };
}

const VALID_STORE_STATUSES = ["active", "suspended"] as const;

export async function setStoreStatus(
  storeId: string,
  targetStatus: "suspended" | "active",
): Promise<StoreFormState> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(z.strictObject({
    storeId: z.string().min(1).max(200),
    targetStatus: z.enum(VALID_STORE_STATUSES),
  }), { storeId, targetStatus });
  if (!parsed.ok) {
    return { error: `Invalid status: must be one of ${VALID_STORE_STATUSES.join(", ")}` };
  }

  const result = await platformAdminTransaction(async (tx) => {
    const before = await tx.store.findUnique({ where: { id: storeId } });
    if (!before) return { error: "Store not found" as const };

    if (before.status === targetStatus) {
      return { noop: true as const, storeId: before.id };
    }

    const store = await tx.store.update({
      where: { id: storeId },
      data: { status: targetStatus },
    });

    await tx.auditLog.create({
      data: {
        storeId: store.id,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: targetStatus === "suspended" ? "store.suspend" : "store.unsuspend",
        entityType: "store",
        entityId: store.id,
        before: { status: before.status },
        after: { status: store.status },
      },
    });

    return { store };
  });

  if ("error" in result) return { error: result.error };
  if ("noop" in result) return { success: true, storeId: result.storeId };

  revalidateStore(result.store);
  return { success: true, storeId: result.store.id };
}

export async function listStores() {
  await requirePlatformAdmin();
  return platformAdmin.store.findMany({
    orderBy: { createdAt: "desc" },
    include: { subscription: { select: { plan: true, status: true, pilot: true, paymentFailedAt: true, trialEndsAt: true } } },
  });
}

export async function getStoreSubscription(storeId: string) {
  await requirePlatformAdmin();
  return platformAdmin.storeSubscription.findUnique({ where: { storeId } });
}

/** Platform admin grants or removes the pilot offer (3 free months, at most 5 stores). */
export async function setPilotAction(formData: FormData): Promise<void> {
  const session = await requirePlatformAdmin();
  const fields = parseInput(z.strictObject({
    storeId: z.string().min(1).max(200),
    pilot: z.enum(["true", "false"]),
  }), readFormFields(formData, ["storeId", "pilot"]));
  if (!fields.ok) redirect("/admin/stores");
  const result = await setPilot(fields.data.storeId, fields.data.pilot === "true", {
    id: session.user.id,
    email: session.user.email,
  });
  const query = result.ok ? "" : `?pilotError=${encodeURIComponent(result.error)}`;
  revalidatePath(`/admin/stores/${fields.data.storeId}`);
  redirect(`/admin/stores/${fields.data.storeId}${query}`);
}

/** Platform admin queues the courier registration job again for one store (#526). */
export async function retryCourierRegistrationAction(formData: FormData): Promise<void> {
  const session = await requirePlatformAdmin();
  const fields = parseInput(z.strictObject({ storeId: z.string().min(1).max(200) }), readFormFields(formData, ["storeId"]));
  if (!fields.ok) redirect("/admin/stores");
  const { storeId } = fields.data;
  const store = await platformAdmin.store.findUnique({ where: { id: storeId }, select: { id: true } });
  if (!store) redirect("/admin/stores");
  await platformAdminTransaction((tx) =>
    tx.auditLog.create({
      data: {
        storeId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "store.courier_registration_retry",
        entityType: "store",
        entityId: storeId,
      },
    }),
  );
  const queued = await requestCourierRegistration(storeId);
  revalidatePath(`/admin/stores/${storeId}`);
  redirect(`/admin/stores/${storeId}?courierRetry=${queued ? "queued" : "failed"}`);
}

export async function getStoreById(id: string) {
  await requirePlatformAdmin();
  const parsed = parseInput(z.string().min(1).max(200), id);
  if (!parsed.ok) return null;
  return platformAdmin.store.findUnique({ where: { id: parsed.data } });
}

export async function inviteStoreOwnerAction(formData: FormData) {
  const session = await requirePlatformAdmin();
  const fields = parseInput(z.strictObject({
    storeId: z.string().max(200).nullable(),
    email: z.string().max(320).nullable(),
  }), readFormFields(formData, ["storeId", "email"]));
  const storeId = fields.ok ? fields.data.storeId : null;
  const email = fields.ok ? fields.data.email : null;

  if (!storeId || !email) {
    return { error: "Store ID and email are required" };
  }

  const store = await platformAdmin.store.findUnique({
    where: { id: storeId },
  });
  if (!store) {
    return { error: "Store not found" };
  }

  try {
    const result = await createInvite({
      storeId: store.id,
      email,
      role: "owner",
      invitedById: session.user.id,
      actorEmail: session.user.email,
      baseUrl: resolveAuthBaseUrl(),
      storeSlug: store.slug,
      storeName: store.name,
    });
    return { success: true, id: result.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send invite";
    return { error: message };
  }
}
