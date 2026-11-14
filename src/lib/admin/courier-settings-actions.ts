"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { platformAdminTransaction } from "../db";
import {
  ASSIGNMENT_TIMEOUT_SECONDS,
  COURIER_SELECTION_MODES,
  COURIER_WEIGHT_LIMIT_LB,
  saveCourierSettings,
  type CourierSettings,
} from "../delivery/courier-settings";
import { parseInput, readFormFields } from "../security/parse-input";
import { requirePlatformAdmin } from "./session";

const FIELDS = ["selectionMode", "assignmentTimeoutSeconds", "weightLimitLb", "doordashEnabled", "uberEnabled"] as const;
type Field = (typeof FIELDS)[number];

export interface CourierSettingsFormState {
  saved?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<Field, string>>;
  /** What the admin sent, so a refused form keeps their input. */
  submitted?: Partial<Record<Field, string>>;
}

/** Whole numbers only: "600.5" or "6e2" is refused, never rounded. */
function wholeNumberIn(range: { min: number; max: number }, message: string) {
  return z.string().trim().regex(/^\d{1,6}$/, message).transform(Number).pipe(z.number().int().min(range.min, message).max(range.max, message));
}

const SCHEMAS = {
  selectionMode: z.enum(COURIER_SELECTION_MODES, "Choose how the courier is picked."),
  assignmentTimeoutSeconds: wholeNumberIn(
    ASSIGNMENT_TIMEOUT_SECONDS,
    `Enter whole seconds from ${ASSIGNMENT_TIMEOUT_SECONDS.min} to ${ASSIGNMENT_TIMEOUT_SECONDS.max}.`,
  ),
  weightLimitLb: wholeNumberIn(COURIER_WEIGHT_LIMIT_LB, `Enter whole pounds from ${COURIER_WEIGHT_LIMIT_LB.min} to ${COURIER_WEIGHT_LIMIT_LB.max}.`),
  /** A checkbox sends "on" when ticked and nothing when not. */
  switch: z.literal("on").nullable().transform((v) => v === "on"),
};

/**
 * Platform admin saves the courier settings (#535). Every field is checked before anything is written; a value out
 * of range is refused, never clamped. saveCourierSettings writes the audit row.
 */
export async function saveCourierSettingsAction(_prev: CourierSettingsFormState, formData: FormData): Promise<CourierSettingsFormState> {
  const session = await requirePlatformAdmin();
  const raw = readFormFields(formData, FIELDS);
  const submitted = Object.fromEntries(FIELDS.map((f) => [f, typeof raw[f] === "string" ? raw[f] : ""])) as Record<Field, string>;
  const fieldErrors: Partial<Record<Field, string>> = {};
  const read = <T,>(field: Field, schema: z.ZodType<T, unknown>): T | undefined => {
    const parsed = parseInput(schema, raw[field]);
    if (parsed.ok) return parsed.data;
    fieldErrors[field] = parsed.issues[0];
    return undefined;
  };
  const after = {
    selectionMode: read("selectionMode", SCHEMAS.selectionMode),
    assignmentTimeoutSeconds: read("assignmentTimeoutSeconds", SCHEMAS.assignmentTimeoutSeconds),
    doordashEnabled: read("doordashEnabled", SCHEMAS.switch),
    uberEnabled: read("uberEnabled", SCHEMAS.switch),
    weightLimitLb: read("weightLimitLb", SCHEMAS.weightLimitLb),
  };
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, submitted };

  await platformAdminTransaction((tx) => saveCourierSettings(tx, { id: session.user.id, email: session.user.email }, after as CourierSettings));
  revalidatePath("/admin/settings/couriers");
  return { saved: true };
}
