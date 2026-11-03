"use server";

import { requireStoreOwner } from "../store-admin/session";
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
  const file = formData.get("file") as File | null;

  if (!file || file.size === 0) {
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

  if (!importToken) {
    return { error: "Missing import token. Please upload the file again." };
  }

  try {
    const result = await commitImport(
      session.store.id,
      importToken,
      selection,
      toActor(session.user),
    );
    revalidateStorefront(session.store.id);
    return { result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    const safe = /^(Import token|This import|No rows|No valid|All selected|Resolution for|Row \d)/.test(msg);
    if (!safe) console.error("[csv-import] commit error:", e);
    return { error: safe ? msg : "Import failed. Please try again." };
  }
}
