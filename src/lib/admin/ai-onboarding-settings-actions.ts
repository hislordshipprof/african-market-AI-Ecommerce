"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { platformAdminTransaction } from "../db";
import { parseInput, readFormFields } from "../security/parse-input";
import { AI_ONBOARDING_LIMITS, saveAiOnboardingSettings, type AiOnboardingSettings } from "./ai-onboarding-settings";
import { requirePlatformAdmin } from "./session";

const FIELDS = ["goLiveListingFloor", "dailySamplePerStore", "turnCostFlagCents", "rejectedApplicationRetentionMonths"] as const;
type Field = (typeof FIELDS)[number];

export interface AiOnboardingSettingsFormState {
  saved?: boolean;
  fieldErrors?: Partial<Record<Field, string>>;
  /** What the admin sent, so a refused form keeps their input. */
  submitted?: Partial<Record<Field, string>>;
}

const UNITS: Record<Field, string> = {
  goLiveListingFloor: "listings",
  dailySamplePerStore: "chats",
  turnCostFlagCents: "cents",
  rejectedApplicationRetentionMonths: "months",
};

/** Whole numbers only: "2.5" or "2e1" is refused, never rounded or clamped. */
function schemaFor(field: Field) {
  const { min, max } = AI_ONBOARDING_LIMITS[field];
  const message = `Enter whole ${UNITS[field]} from ${min} to ${max}.`;
  return z.string().trim().regex(/^\d{1,6}$/, message).transform(Number).pipe(z.number().int().min(min, message).max(max, message));
}

/**
 * Platform admin saves the AI and onboarding settings (#561). Every field is checked before anything is written; a
 * value out of range is refused, never clamped. saveAiOnboardingSettings writes the audit row in the same transaction.
 */
export async function saveAiOnboardingSettingsAction(_prev: AiOnboardingSettingsFormState, formData: FormData): Promise<AiOnboardingSettingsFormState> {
  const session = await requirePlatformAdmin();
  const raw = readFormFields(formData, FIELDS);
  const submitted = Object.fromEntries(FIELDS.map((f) => [f, typeof raw[f] === "string" ? raw[f] : ""])) as Record<Field, string>;
  const fieldErrors: Partial<Record<Field, string>> = {};
  const next: Partial<AiOnboardingSettings> = {};
  for (const field of FIELDS) {
    const parsed = parseInput(schemaFor(field), raw[field]);
    if (parsed.ok) next[field] = parsed.data;
    else fieldErrors[field] = parsed.issues[0];
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, submitted };

  await platformAdminTransaction((tx) => saveAiOnboardingSettings(tx, { id: session.user.id, email: session.user.email }, next as AiOnboardingSettings));
  revalidatePath("/admin/settings/ai-onboarding");
  return { saved: true };
}
