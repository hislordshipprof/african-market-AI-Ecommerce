"use server";

import { z } from "zod";
import { requireStoreOwner } from "./session";
import { parseInput } from "../security/parse-input";
import { saveStoreSettings, type SettingsResult } from "../store-settings/settings";
import { clearStoreChange } from "../store-settings/store-change";
import { STORE_ABOUT_MAX } from "../store-settings/fields";
import { WEEK_DAYS } from "../store-settings/weekly-hours";
import { SLOT_FIELD_NAMES } from "../admin/slot-form";

const day = z.strictObject({ closed: z.boolean(), open: z.string().max(10), close: z.string().max(10) });
const settingsSchema = z.strictObject({
  hours: z.strictObject(Object.fromEntries(WEEK_DAYS.map((d) => [d, day])) as Record<(typeof WEEK_DAYS)[number], typeof day>),
  timezone: z.string().max(80),
  pickupEnabled: z.boolean(),
  minimumOrderCents: z.number().int(),
  phone: z.string().max(40),
  about: z.string().max(STORE_ABOUT_MAX * 4),
  /** The slot fields by their form name (#807), as the platform admin store form posts them. */
  slots: z.partialRecord(z.enum(SLOT_FIELD_NAMES as [string, ...string[]]), z.string().max(400)),
});

/** Owner only. The store is the session's; the input never names one. */
export async function updateStoreSettings(input: unknown): Promise<SettingsResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(settingsSchema, input);
  if (!parsed.ok) return { ok: false, message: "That did not save. Check each field and try again." };
  return saveStoreSettings(session.store.id, parsed.data, { id: session.user.id, email: session.user.email });
}

const storeChangeRefSchema = z.union([
  z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.strictObject({ deliveryPause: z.literal(true) }),
]);

/** Owner only. Removes one one-off day or the delivery pause (#819) from the session's store. */
export async function removeStoreChange(input: unknown): Promise<SettingsResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(storeChangeRefSchema, input);
  if (!parsed.ok) return { ok: false, message: "That did not remove. Reload the page and try again." };
  return clearStoreChange(session.store.id, parsed.data, { id: session.user.id, email: session.user.email });
}
