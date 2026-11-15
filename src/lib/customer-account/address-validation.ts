import { validPhone } from "./phone";

export const USPS_STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
  "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

const USPS_STATES = new Set<string>(USPS_STATE_CODES);

const ZIP_RE = /^\d{5}(-\d{4})?$/;

export interface AddressInput {
  label: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
  notes: string | null;
}

export type AddressValidation =
  | { ok: true; value: AddressInput }
  | { ok: false; error: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optional(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = text(value);
  return trimmed === "" ? null : trimmed;
}

export const ADDRESS_MESSAGES = {
  label: "Enter an address label of 1 to 40 characters.",
  line1: "Enter a street address of at most 100 characters.",
  line2: "Address line 2 must be at most 100 characters.",
  city: "Enter a city of at most 60 characters.",
  state: "Enter a US state or DC.",
  zip: "Enter a 5-digit ZIP code.",
  notes: "Notes must be at most 280 characters.",
  invalid: "Check the address and try again.",
} as const;

export function validateAddress(input: unknown): AddressValidation {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const label = text(source.label);
  const line1 = text(source.line1);
  const line2 = optional(source.line2);
  const city = text(source.city);
  const state = text(source.state).toUpperCase();
  const zip = text(source.zip);
  const notes = optional(source.notes);

  if (label.length < 1 || label.length > 40) {
    return { ok: false, error: ADDRESS_MESSAGES.label };
  }
  if (line1.length < 1 || line1.length > 100) {
    return { ok: false, error: ADDRESS_MESSAGES.line1 };
  }
  if (line2 && line2.length > 100) {
    return { ok: false, error: ADDRESS_MESSAGES.line2 };
  }
  if (city.length < 1 || city.length > 60) {
    return { ok: false, error: ADDRESS_MESSAGES.city };
  }
  if (!USPS_STATES.has(state)) {
    return { ok: false, error: ADDRESS_MESSAGES.state };
  }
  if (!ZIP_RE.test(zip)) {
    return { ok: false, error: ADDRESS_MESSAGES.zip };
  }
  if (notes && notes.length > 280) {
    return { ok: false, error: ADDRESS_MESSAGES.notes };
  }
  return { ok: true, value: { label, line1, line2, city, state, zip, notes } };
}

export function normalizeAccountPhone(phone: unknown): { ok: true; phone: string | null } | { ok: false; error: string } {
  if (phone == null) return { ok: true, phone: null };
  if (typeof phone !== "string") return { ok: false, error: "Enter a valid phone number." };
  const trimmed = phone.trim();
  if (trimmed === "") return { ok: true, phone: null };
  if (!validPhone(trimmed)) return { ok: false, error: "Enter a valid phone number." };
  return { ok: true, phone: trimmed };
}

export const ADDRESS_CAP = 20;
export const ADDRESS_CAP_MESSAGE = "You can save up to 20 addresses";
export const ADDRESS_NOT_FOUND = "Address not found";
export const SIGN_IN_MESSAGE = "Sign in to continue";
