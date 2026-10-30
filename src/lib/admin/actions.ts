"use server";

import { revalidateStore } from "../get-store";
import { platformAdmin } from "../db";
import { writeAuditLog } from "./audit";
import { requirePlatformAdmin } from "./session";
import { nudgeForContrast, getThemeTokens, VALID_PRESETS } from "../theme";
import type { ThemePreset } from "../theme";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export type StoreFormState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  success?: boolean;
  storeId?: string;
  brandColorNudged?: boolean;
  nudgedColor?: string;
};

function validateStoreFields(data: FormData): {
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
  const prepTimeMinutes = parseInt(data.get("prepTimeMinutes") as string) || 30;
  const deliveryRadiusMi = parseFloat(data.get("deliveryRadiusMi") as string) || 8;
  const minimumOrderCents = Math.round(
    (parseFloat(data.get("minimumOrder") as string) || 35) * 100,
  );
  const pickupEnabled = data.get("pickupEnabled") === "on";
  const autoRefundLimitCents = Math.round(
    (parseFloat(data.get("autoRefundLimit") as string) || 25) * 100,
  );

  if (!slug) errors.slug = "Slug is required";
  else if (!SLUG_RE.test(slug)) errors.slug = "Slug must be lowercase alphanumeric with hyphens, 1-63 characters";

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

  if (prepTimeMinutes < 1 || prepTimeMinutes > 480) {
    errors.prepTimeMinutes = "Prep time must be 1-480 minutes";
  }

  if (deliveryRadiusMi < 1 || deliveryRadiusMi > 15) {
    errors.deliveryRadiusMi = "Delivery radius must be 1-15 miles";
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
    },
  };
}

export async function createStore(
  _prev: StoreFormState,
  data: FormData,
): Promise<StoreFormState> {
  const session = await requirePlatformAdmin();

  const { errors, values } = validateStoreFields(data);
  if (Object.keys(errors).length > 0) {
    return { fieldErrors: errors };
  }

  const existing = await platformAdmin.store.findUnique({
    where: { slug: values.slug },
  });
  if (existing) {
    return { fieldErrors: { slug: "A store with this slug already exists" } };
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

  const store = await platformAdmin.store.create({
    data: {
      slug: values.slug,
      name: values.name,
      logoUrl: values.logoUrl,
      brandColor: finalBrandColor,
      themePreset: values.themePreset,
      status: values.status,
      hours: values.hours ?? undefined,
      prepTimeMinutes: values.prepTimeMinutes,
      deliveryRadiusMi: values.deliveryRadiusMi,
      minimumOrderCents: values.minimumOrderCents,
      pickupEnabled: values.pickupEnabled,
      autoRefundLimitCents: values.autoRefundLimitCents,
    },
  });

  revalidateStore(store);

  await writeAuditLog({
    storeId: store.id,
    actorId: session.user.id,
    actorEmail: session.user.email,
    action: "store.create",
    entityType: "store",
    entityId: store.id,
    after: {
      slug: store.slug,
      name: store.name,
      brandColor: store.brandColor,
      themePreset: store.themePreset,
      status: store.status,
    },
  });

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

  const { errors, values } = validateStoreFields(data);
  if (Object.keys(errors).length > 0) {
    return { fieldErrors: errors };
  }

  if (values.slug !== before.slug) {
    const slugTaken = await platformAdmin.store.findUnique({
      where: { slug: values.slug },
    });
    if (slugTaken && slugTaken.id !== storeId) {
      return { fieldErrors: { slug: "A store with this slug already exists" } };
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

  const store = await platformAdmin.store.update({
    where: { id: storeId },
    data: {
      slug: values.slug,
      name: values.name,
      logoUrl: values.logoUrl,
      brandColor: finalBrandColor,
      themePreset: values.themePreset,
      status: values.status,
      hours: values.hours ?? undefined,
      prepTimeMinutes: values.prepTimeMinutes,
      deliveryRadiusMi: values.deliveryRadiusMi,
      minimumOrderCents: values.minimumOrderCents,
      pickupEnabled: values.pickupEnabled,
      autoRefundLimitCents: values.autoRefundLimitCents,
    },
  });

  revalidateStore(store);
  if (before.slug !== store.slug) {
    revalidateStore({ id: before.id, slug: before.slug });
  }

  await writeAuditLog({
    storeId: store.id,
    actorId: session.user.id,
    actorEmail: session.user.email,
    action: "store.update",
    entityType: "store",
    entityId: store.id,
    before: {
      slug: before.slug,
      name: before.name,
      brandColor: before.brandColor,
      themePreset: before.themePreset,
      status: before.status,
    },
    after: {
      slug: store.slug,
      name: store.name,
      brandColor: store.brandColor,
      themePreset: store.themePreset,
      status: store.status,
    },
  });

  return {
    success: true,
    storeId: store.id,
    brandColorNudged,
    nudgedColor,
  };
}

export async function suspendStore(storeId: string): Promise<StoreFormState> {
  const session = await requirePlatformAdmin();

  const before = await platformAdmin.store.findUnique({
    where: { id: storeId },
  });
  if (!before) return { error: "Store not found" };

  const newStatus = before.status === "suspended" ? "active" : "suspended";
  const store = await platformAdmin.store.update({
    where: { id: storeId },
    data: { status: newStatus },
  });

  revalidateStore(store);

  await writeAuditLog({
    storeId: store.id,
    actorId: session.user.id,
    actorEmail: session.user.email,
    action: newStatus === "suspended" ? "store.suspend" : "store.unsuspend",
    entityType: "store",
    entityId: store.id,
    before: { status: before.status },
    after: { status: store.status },
  });

  return { success: true, storeId: store.id };
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
