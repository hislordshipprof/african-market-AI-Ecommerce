/** CSV upload cap. No server imports and no env reads: next.config.ts loads this module. */

export const CSV_FILE_CAP_BYTES = 2 * 1024 * 1024;

export const CSV_ACTION_BODY_HEADROOM_BYTES = 64 * 1024;

/** App-wide Server Action body limit. Next.js has no per-action limit. */
export const CSV_ACTION_BODY_LIMIT_BYTES = CSV_FILE_CAP_BYTES + CSV_ACTION_BODY_HEADROOM_BYTES;

/** A photo sent through a server action: at the file cap, the form still fits the body limit. */
export const PHOTO_UPLOAD_MAX_BYTES = CSV_FILE_CAP_BYTES;

export const CSV_FILE_TOO_LARGE_MESSAGE = "File exceeds the maximum size of 2 MB.";

export function csvFileTooLarge(bytes: number): string | null {
  if (bytes > CSV_FILE_CAP_BYTES) return CSV_FILE_TOO_LARGE_MESSAGE;
  return null;
}
