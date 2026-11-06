import type { ZodType } from "zod";

export type ParseSuccess<T> = { ok: true; data: T };
export type ParseFailure = { ok: false; issues: string[] };
export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/** Shared trust-boundary parse. Callers map a failure onto their existing error shape. */
export function parseInput<T>(schema: ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => issue.message),
  };
}

/**
 * Server Actions are decoded from the request body. A `FormData` parameter can
 * arrive as an object, null, or string. Only a real `FormData` may be read.
 */
function asFormData(value: unknown): FormData | null {
  return value instanceof FormData ? value : null;
}

/** One named field. A missing form or field is null. A file stays a file. */
export function readFormField(formData: unknown, name: string): FormDataEntryValue | null {
  return asFormData(formData)?.get(name) ?? null;
}

/**
 * Named form fields only. React adds `$ACTION_*` entries; `Object.fromEntries`
 * would treat those as payload. A missing field is null. A file stays a file
 * so a string schema rejects it. Callers use the parsed value, not a second read.
 */
export function readFormFields(
  formData: unknown,
  names: readonly string[],
): Record<string, FormDataEntryValue | null> {
  const fields: Record<string, FormDataEntryValue | null> = {};
  for (const name of names) {
    fields[name] = readFormField(formData, name);
  }
  return fields;
}
