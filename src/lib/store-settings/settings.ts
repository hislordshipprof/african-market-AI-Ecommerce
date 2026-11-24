import { platformAdminTransaction } from "../db";
import { revalidateStore } from "../get-store";
import { VALID_US_TIMEZONES } from "../admin/timezone";
import { MINIMUM_ORDER_MAX_CENTS, STORE_ABOUT_MAX } from "./fields";
import { storePhone } from "./store-phone";
import { weeklyHoursError, writeWeeklyHours, type WeekHours } from "./weekly-hours";


export interface StoreSettingsInput {
  hours: WeekHours;
  timezone: string;
  pickupEnabled: boolean;
  minimumOrderCents: number;
  phone: string;
  about: string;
}

export type SettingsResult = { ok: true } | { ok: false; message: string };

const refuse = (message: string): SettingsResult => ({ ok: false, message });

const AUDITED = { hours: true, timezone: true, pickupEnabled: true, minimumOrderCents: true, phone: true, ownerStory: true } as const;

/**
 * The owner's store settings (#786): weekly hours, time zone, pickup, one minimum order for every fulfillment, phone
 * and about. Saving marks the time zone as set for the go-live checklist. Every save writes an audit row.
 */
export async function saveStoreSettings(storeId: string, input: StoreSettingsInput, actor: { id: string; email: string }): Promise<SettingsResult> {
  const hoursError = weeklyHoursError(input.hours);
  if (hoursError) return refuse(hoursError);
  if (!(VALID_US_TIMEZONES as readonly string[]).includes(input.timezone)) return refuse("Pick a US time zone.");
  if (!Number.isInteger(input.minimumOrderCents) || input.minimumOrderCents < 0 || input.minimumOrderCents > MINIMUM_ORDER_MAX_CENTS) {
    return refuse("The minimum order is $0 to $1,000.");
  }
  const phone = storePhone(input.phone);
  if (!phone.ok) return refuse("Enter a 10-digit US phone number, or leave it empty.");
  const about = input.about.trim().replace(/[ \t]+/g, " ") || null;
  if (about && [...about].length > STORE_ABOUT_MAX) return refuse(`Keep "About the store" to ${STORE_ABOUT_MAX} characters.`);

  const after = {
    hours: writeWeeklyHours(input.hours),
    timezone: input.timezone,
    pickupEnabled: input.pickupEnabled,
    minimumOrderCents: input.minimumOrderCents,
    phone: phone.phone,
    ownerStory: about,
  };
  const store = await platformAdminTransaction(async (tx) => {
    const before = await tx.store.findUnique({ where: { id: storeId }, select: { id: true, slug: true, customDomain: true, ...AUDITED } });
    if (!before) return null;
    await tx.store.update({ where: { id: storeId }, data: { ...after, timezoneSetAt: new Date() } });
    const { id, slug, customDomain, ...audited } = before;
    await tx.auditLog.create({
      data: { storeId, actorId: actor.id, actorEmail: actor.email, action: "store.settings", entityType: "store", entityId: storeId, before: audited, after },
    });
    return { id, slug, customDomain };
  });
  if (!store) return refuse("Store not found.");
  revalidateStore(store);
  return { ok: true };
}
