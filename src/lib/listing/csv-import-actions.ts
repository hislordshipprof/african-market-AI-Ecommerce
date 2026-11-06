"use server";

import { z } from "zod";
import { requireStoreOwner } from "../store-admin/session";
import { parseInput, readFormField } from "../security/parse-input";
import {
  generatePreview,
  commitImport,
  validateFileSize,
  MAX_FILE_BYTES,
  type CsvPreviewResult,
  type CommitSelection,
  type CommitResult,
} from "./csv-import";
import { CsvImportRejection } from "./csv-import-error";
import { readCsvUpload } from "./csv-upload";
import { toActor } from "./service";
import { revalidateStorefront } from "../storefront/cache";

export interface PreviewActionResult {
  error?: string;
  preview?: CsvPreviewResult;
}

export async function csvPreviewAction(
  formData: FormData,
): Promise<PreviewActionResult> {
  const session = await requireStoreOwner();
  const file = readFormField(formData, "file");
  const selected = parseInput(
    z.custom<File>((value) => value instanceof File && value.size > 0),
    file,
  );
  if (!selected.ok) return { error: "Please select a CSV file." };
  const sized = parseInput(z.number().int().nonnegative().max(MAX_FILE_BYTES), selected.data.size);
  if (!sized.ok) {
    return { error: validateFileSize(selected.data.size) ?? "Please select a CSV file." };
  }

  const bytes = new Uint8Array(await selected.data.arrayBuffer());
  const decoded = readCsvUpload(bytes);
  if ("error" in decoded) return { error: decoded.error };
  const preview = await generatePreview(session.store.id, decoded.text, session.user.id);

  const hasContent =
    preview.matches.length > 0 ||
    preview.newItems.length > 0 ||
    preview.ambiguous.length > 0 ||
    preview.alreadyListed.length > 0 ||
    preview.duplicates.length > 0;

  if (!hasContent && preview.errors.length > 0) {
    return { error: preview.errors[0].reason };
  }

  return { preview };
}

export interface CommitActionResult {
  error?: string;
  result?: CommitResult;
}

export async function csvCommitAction(
  importToken: string,
  selection: CommitSelection,
): Promise<CommitActionResult> {
  const session = await requireStoreOwner();
  const token = parseInput(z.string().min(1).max(200), importToken);
  const selectionParsed = parseInput(z.strictObject({
    matchedRows: z.array(z.number().int()).max(5001),
    newItemRows: z.array(z.number().int()).max(5001),
    ambiguousResolutions: z.array(z.strictObject({
      row: z.number().int(),
      masterProductId: z.string().min(1).max(200),
    })).max(5001),
    matchedIdentities: z.array(z.strictObject({
      row: z.number().int(),
      masterProductId: z.string().min(1).max(200),
    })).max(5001).optional(),
  }), selection);
  if (!token.ok) {
    return { error: "Missing import token. Please upload the file again." };
  }
  if (!selectionParsed.ok) {
    return { error: "No rows selected." };
  }

  let result: CommitResult;
  try {
    result = await commitImport(
      session.store.id,
      token.data,
      selectionParsed.data,
      toActor(session.user),
    );
  } catch (e) {
    if (e instanceof CsvImportRejection) return { error: e.message };
    console.error("[csv-import] commit error:", e);
    return { error: "Import failed. Please try again." };
  }

  // Only a synchronous throw is caught here. Next applies queued tags after
  // this function returns, and a failure there is outside this result.
  try {
    revalidateStorefront(session.store.id);
  } catch (e) {
    console.error("[csv-import] storefront revalidation failed:", e);
  }
  return { result };
}
