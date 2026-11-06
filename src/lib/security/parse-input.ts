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
 * Named form fields only. React adds `$ACTION_*` entries; `Object.fromEntries`
 * would treat those as payload. A missing field is null. A file stays a file
 * so a string schema rejects it. Callers use the parsed value, not a second read.
 */
export function readFormFields(
  formData: FormData,
  names: readonly string[],
): Record<string, FormDataEntryValue | null> {
  const fields: Record<string, FormDataEntryValue | null> = {};
  for (const name of names) {
    fields[name] = formData.get(name);
  }
  return fields;
}
