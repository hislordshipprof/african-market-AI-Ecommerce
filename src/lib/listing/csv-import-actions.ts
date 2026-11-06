"use server";

import { z } from "zod";
import { requireStoreOwner } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import {
  generatePreview,
  commitImport,
  validateFileSize,
  type CsvPreviewResult,
  type CommitSelection,
  type CommitResult,
} from "./csv-import";
import type { Actor } from "./service";
import { revalidateStorefront } from "../storefront/cache";

function toActor(user: { id: string; email: string }): Actor {
  return { id: user.id, email: user.email };
}

export interface PreviewActionResult {
  error?: string;
  preview?: CsvPreviewResult;
}

export async function csvPreviewAction(
  formData: FormData,
): Promise<PreviewActionResult> {
  const session = await requireStoreOwner();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Please select a CSV file." };
  }

  const sizeError = validateFileSize(file.size);
  if (sizeError) return { error: sizeError };

  const csvText = await file.text();
  const preview = await generatePreview(session.store.id, csvText, session.user.id);

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
    const msg = e instanceof Error ? e.message : "";
    const safe = /^(Import token|This import|No rows|No valid|All selected|Resolution for|Row \d)/.test(msg);
    if (!safe) console.error("[csv-import] commit error:", e);
    return { error: safe ? msg : "Import failed. Please try again." };
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
