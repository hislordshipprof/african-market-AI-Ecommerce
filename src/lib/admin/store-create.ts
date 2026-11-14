import { Prisma, type PrismaClient } from "@prisma/client";
import type { SlotSchedule } from "../order/slot-schedule";

/** The fields a new store row is created with: the admin form and an approved store application (#554). */
export type NewStoreValues = {
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
  lat: number | null;
  lng: number | null;
  storeDeliveryEnabled: boolean;
  storeDeliveryFeeCents: number;
  pickupSlotSettings: SlotSchedule | null;
  storeDeliverySlotSettings: SlotSchedule | null;
};

/** Creates the store and its `store.create` audit row inside the caller's platform-admin transaction. */
export async function insertStore(
  tx: Pick<PrismaClient, "store" | "auditLog">,
  values: NewStoreValues,
  actor: { id: string; email: string },
) {
  const s = await tx.store.create({
    data: {
      slug: values.slug,
      name: values.name,
      logoUrl: values.logoUrl,
      brandColor: values.brandColor,
      themePreset: values.themePreset,
      status: values.status,
      hours: values.hours !== null ? (values.hours as Prisma.InputJsonValue) : Prisma.JsonNull,
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
      lat: values.lat,
      lng: values.lng,
      storeDeliveryEnabled: values.storeDeliveryEnabled,
      storeDeliveryFeeCents: values.storeDeliveryFeeCents,
      pickupSlotSettings: values.pickupSlotSettings ?? Prisma.JsonNull,
      storeDeliverySlotSettings: values.storeDeliverySlotSettings ?? Prisma.JsonNull,
    },
  });

  await tx.auditLog.create({
    data: {
      storeId: s.id,
      actorId: actor.id,
      actorEmail: actor.email,
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
        addressLine1: s.addressLine1,
        addressLine2: s.addressLine2,
        city: s.city,
        state: s.state,
        zip: s.zip,
        lat: s.lat,
        lng: s.lng,
        storeDeliveryEnabled: s.storeDeliveryEnabled,
        storeDeliveryFeeCents: s.storeDeliveryFeeCents,
      },
    },
  });

  return s;
}
