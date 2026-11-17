"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { platformAdminTransaction } from "../db";
import { ASSIGNMENT_TIMEOUT_SECONDS, COURIER_SELECTION_MODES } from "../delivery/courier-settings";
import { isStateCode, type StateCode } from "../directory/us-states";
import { parseInput, readFormFields } from "../security/parse-input";
import { METRO_MAX_STATES, METRO_RADIUS_MI, saveMetro, setStoreMetro, type MetroInput } from "./metros";
import { requirePlatformAdmin } from "./session";

const FIELDS = [
  "name",
  "states",
  "centerLat",
  "centerLng",
  "radiusMi",
  "courierSelectionMode",
  "courierAssignmentTimeoutS",
  "doordashEnabled",
  "uberEnabled",
] as const;
type Field = (typeof FIELDS)[number];

export interface MetroFormState {
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

function degreesIn(limit: number, message: string) {
  return z.string().trim().regex(/^-?\d{1,3}(\.\d{1,7})?$/, message).transform(Number).pipe(z.number().min(-limit, message).max(limit, message));
}

const STATES_MESSAGE = `Enter 1 to ${METRO_MAX_STATES} US state codes, such as MD, DC, VA.`;
const TIMEOUT_MESSAGE = `Leave empty to follow the platform, or enter whole seconds from ${ASSIGNMENT_TIMEOUT_SECONDS.min} to ${ASSIGNMENT_TIMEOUT_SECONDS.max}.`;

const SCHEMAS = {
  name: z.string().trim().min(1, "Enter a name.").max(60, "Keep the name to 60 characters."),
  states: z
    .string()
    .transform((value) => [...new Set(value.toUpperCase().split(/[\s,]+/).filter(Boolean))])
    .pipe(z.array(z.string().refine(isStateCode, STATES_MESSAGE)).min(1, STATES_MESSAGE).max(METRO_MAX_STATES, STATES_MESSAGE))
    .transform((codes) => codes as StateCode[]),
  centerLat: degreesIn(90, "Enter a latitude from -90 to 90."),
  centerLng: degreesIn(180, "Enter a longitude from -180 to 180."),
  radiusMi: wholeNumberIn(METRO_RADIUS_MI, `Enter whole miles from ${METRO_RADIUS_MI.min} to ${METRO_RADIUS_MI.max}.`),
  /** Empty follows the platform setting. */
  courierSelectionMode: z.union([z.literal("").transform(() => null), z.enum(COURIER_SELECTION_MODES)], "Choose how the courier is picked."),
  courierAssignmentTimeoutS: z.union([z.string().trim().length(0).transform(() => null), wholeNumberIn(ASSIGNMENT_TIMEOUT_SECONDS, TIMEOUT_MESSAGE)], TIMEOUT_MESSAGE),
  /** A checkbox sends "on" when ticked and nothing when not. */
  switch: z.literal("on").nullable().transform((v) => v === "on"),
};

const METRO_ID = z.string().trim().min(1).max(200);

/**
 * Platform admin creates a metro, or edits one (#577). Every field is checked before anything is written; a value out
 * of range is refused, never clamped. saveMetro writes the audit row. A new metro opens its own page.
 */
export async function saveMetroAction(_prev: MetroFormState, formData: FormData): Promise<MetroFormState> {
  const session = await requirePlatformAdmin();
  const metroId = readFormFields(formData, ["metroId"]).metroId;
  const id = metroId === null || metroId === "" ? null : parseInput(METRO_ID, metroId);
  if (id && !id.ok) return { error: "This metro no longer exists." };
  const raw = readFormFields(formData, FIELDS);
  const submitted = Object.fromEntries(FIELDS.map((f) => [f, typeof raw[f] === "string" ? raw[f] : ""])) as Record<Field, string>;
  const fieldErrors: Partial<Record<Field, string>> = {};
  const read = <T,>(field: Field, schema: z.ZodType<T, unknown>): T | undefined => {
    const parsed = parseInput(schema, field === "doordashEnabled" || field === "uberEnabled" ? raw[field] : submitted[field]);
    if (parsed.ok) return parsed.data;
    fieldErrors[field] = parsed.issues[0];
    return undefined;
  };
  const input = {
    name: read("name", SCHEMAS.name),
    states: read("states", SCHEMAS.states),
    centerLat: read("centerLat", SCHEMAS.centerLat),
    centerLng: read("centerLng", SCHEMAS.centerLng),
    radiusMi: read("radiusMi", SCHEMAS.radiusMi),
    courierSelectionMode: read("courierSelectionMode", SCHEMAS.courierSelectionMode),
    courierAssignmentTimeoutS: read("courierAssignmentTimeoutS", SCHEMAS.courierAssignmentTimeoutS),
    doordashEnabled: read("doordashEnabled", SCHEMAS.switch),
    uberEnabled: read("uberEnabled", SCHEMAS.switch),
  };
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, submitted };

  let saved: string | null;
  try {
    saved = await platformAdminTransaction((tx) => saveMetro(tx, { id: session.user.id, email: session.user.email }, id ? id.data : null, input as MetroInput));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { fieldErrors: { name: "Another metro has this name." }, submitted };
    }
    throw err;
  }
  if (!saved) return { error: "This metro no longer exists." };
  revalidatePath("/admin/metros");
  revalidatePath(`/admin/metros/${saved}`);
  if (!id) redirect(`/admin/metros/${saved}`);
  return { saved: true };
}

/** Platform admin puts a store in a metro, or in none (#577), with an audit row on the store. */
export async function setStoreMetroAction(formData: FormData): Promise<void> {
  const session = await requirePlatformAdmin();
  const fields = parseInput(
    z.strictObject({ storeId: METRO_ID, metroId: z.string().trim().max(200).transform((v) => (v === "" ? null : v)) }),
    readFormFields(formData, ["storeId", "metroId"]),
  );
  if (!fields.ok) redirect("/admin/stores");
  const { storeId, metroId } = fields.data;
  const ok = await platformAdminTransaction((tx) => setStoreMetro(tx, { id: session.user.id, email: session.user.email }, storeId, metroId));
  revalidatePath(`/admin/stores/${storeId}`);
  revalidatePath("/admin/metros", "layout");
  redirect(`/admin/stores/${storeId}?metro=${ok ? "saved" : "missing"}`);
}
