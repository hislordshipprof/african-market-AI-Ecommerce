import { isUtf8 } from "node:buffer";
import { NON_CSV_REASON, textLooksNonCsv } from "./csv-import";

export const UTF8_REQUIRED_MESSAGE =
  "This file is not saved as UTF-8, so letters like é would be lost. In Excel choose Save As, then CSV UTF-8 (Comma delimited), and upload it again.";

/** Decode an upload from its bytes. `File.text()` is never used for this check. */
export function readCsvUpload(bytes: Uint8Array): { text: string } | { error: string } {
  if (isUtf8(bytes)) {
    return { text: new TextDecoder("utf-8").decode(bytes) };
  }
  const lenient = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (textLooksNonCsv(lenient)) return { error: NON_CSV_REASON };
  return { error: UTF8_REQUIRED_MESSAGE };
}
