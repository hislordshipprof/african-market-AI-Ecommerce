"use server";

import { revalidateStore } from "../get-store";
import { platformAdmin, platformAdminTransaction } from "../db";
import { requirePlatformAdmin } from "./session";
import { nudgeForContrast, getThemeTokens, VALID_PRESETS } from "../theme";
import { isSlugRoutable } from "../slug";
import type { ThemePreset } from "../theme";
import { Prisma } from "@prisma/client";
import { createInvite } from "../invite/service";
import { resolveAuthBaseUrl } from "../auth";

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

function extractRawValues(data: FormData): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const key of ["slug", "name", "logoUrl", "brandColor", "themePreset", "status", "hours", "prepTimeMinutes", "deliveryRadiusMi", "minimumOrder", "autoRefundLimit", "pickupEnabled", "timezone"]) {
    const v = data.get(key);
    if (v != null) raw[key] = String(v);
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
    timezone: string;
  };
} {
  const errors: Record<string, string> = {};

  const slug = (data.get("slug") as string)?.trim().toLowerCase() ?? "";
  const name = (data.get("name") as string)?.trim() ?? "";
  const logoUrl = (data.get("logoUrl") as string)?.trim() || null;
  const brandColor = (data.get("brandColor") as string)?.trim() || null;
  const themePreset = (data.get("themePreset") as string)?.trim() || "palm-and-shea";
  const status = (data.get("status") as string)?.trim() || "active";
  const hoursRaw = (data.get("hours") as string)?.trim() || "";
  const prepTimeMinutes = parseIntOrDefault(data.get("prepTimeMinutes") as string, 30);
  const deliveryRadiusMi = parseFloatOrDefault(data.get("deliveryRadiusMi") as string, 8);
  const minimumOrderCents = Math.round(
    parseFloatOrDefault(data.get("minimumOrder") as string, 35) * 100,
  );
  const pickupEnabled = data.get("pickupEnabled") === "on";
  const autoRefundLimitCents = Math.round(
    parseFloatOrDefault(data.get("autoRefundLimit") as string, 25) * 100,
  );
  const timezone = (data.get("timezone") as string)?.trim() || defaultTimezone;

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

  if (!(VALID_US_TIMEZONES as readonly string[]).includes(timezone)) {
    errors.timezone = `Invalid timezone: must be one of ${VALID_US_TIMEZONES.join(", ")}`;
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
      timezone,
    },
  };
}

export async function createStore(
  _prev: StoreFormState,
  data: FormData,
): Promise<StoreFormState> {
  const session = await requirePlatformAdmin();

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
        timezone: values.timezone,
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
          timezone: s.timezone,
        },
      },
    });

    return s;
  });

  revalidateStore(store);

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

  const storeId = data.get("storeId") as string;
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
        timezone: values.timezone,
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
          timezone: before.timezone,
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
          timezone: s.timezone,
        },
      },
    });

    return s;
  });

  revalidateStore(store);
  if (before.slug !== store.slug) {
    revalidateStore({ id: before.id, slug: before.slug });
  }

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
  if (!(VALID_STORE_STATUSES as readonly string[]).includes(targetStatus)) {
    return { error: `Invalid status: must be one of ${VALID_STORE_STATUSES.join(", ")}` };
  }

  const session = await requirePlatformAdmin();

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
  });
}

export async function getStoreById(id: string) {
  await requirePlatformAdmin();
  return platformAdmin.store.findUnique({ where: { id } });
}

export async function inviteStoreOwnerAction(formData: FormData) {
  const session = await requirePlatformAdmin();
  const storeId = formData.get("storeId") as string | null;
  const email = formData.get("email") as string | null;

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
