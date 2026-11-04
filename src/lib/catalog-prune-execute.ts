import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  CATALOG_PRUNE_BATCH_SIZE,
  CatalogPruneRefusal,
  chunkCatalogKeys,
  type ListedObject,
} from "./catalog-prune";
import type { R2SendClient } from "./catalog-prune-fake-r2";

type DeleteResult = {
  Deleted?: { Key?: string }[];
  Errors?: { Key?: string; Code?: string }[];
};

type ListResult = {
  Contents?: { Key?: string; LastModified?: Date }[];
  IsTruncated?: boolean;
  NextContinuationToken?: string;
};

/**
 * List every page before anything is deleted. A thrown page, a missing token,
 * or a repeated token aborts with no deletes. Quiet mode is not used: every
 * requested key must come back under Deleted or Errors.
 */
export async function listCatalogObjects(
  client: R2SendClient,
  bucket: string,
  prefix = "catalog/",
): Promise<ListedObject[]> {
  const seenTokens = new Set<string>();
  let token: string | undefined;
  const objects: ListedObject[] = [];
  for (;;) {
    let response: ListResult;
    try {
      response = (await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: CATALOG_PRUNE_BATCH_SIZE,
        }),
      )) as ListResult;
    } catch {
      throw new CatalogPruneRefusal(
        "Refusing catalog prune: listing catalog objects failed before any delete",
      );
    }
    for (const object of response.Contents ?? []) {
      if (!object.Key) continue;
      const modified = object.LastModified;
      objects.push({
        key: object.Key,
        lastModified:
          modified instanceof Date && !Number.isNaN(modified.getTime()) ? modified : null,
      });
    }
    if (!response.IsTruncated) return objects;
    const next = response.NextContinuationToken;
    if (!next || seenTokens.has(next)) {
      throw new CatalogPruneRefusal(
        "Refusing catalog prune: catalog listing pagination is malformed",
      );
    }
    seenTokens.add(next);
    token = next;
  }
}

export async function deleteCatalogCandidates(input: {
  client: R2SendClient;
  bucket: string;
  keys: readonly string[];
  log: (line: string) => void;
}): Promise<void> {
  if (input.keys.length === 0) {
    input.log("catalog prune: no candidates");
    return;
  }
  const confirmed: string[] = [];
  for (const batch of chunkCatalogKeys(input.keys)) {
    let response: DeleteResult;
    try {
      response = (await input.client.send(
        new DeleteObjectsCommand({
          Bucket: input.bucket,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            Quiet: false,
          },
        }),
      )) as DeleteResult;
    } catch {
      for (const key of batch) input.log(`unknown ${key}`);
      throw new CatalogPruneRefusal(
        `Refusing catalog prune: outcome unknown for ${batch.length} keys after a transport error; deleted so far ${confirmed.length}`,
      );
    }
    const deleted = new Map<string, true>();
    const failed = new Map<string, string>();
    for (const entry of response.Deleted ?? []) {
      if (entry.Key) deleted.set(entry.Key, true);
    }
    for (const entry of response.Errors ?? []) {
      if (entry.Key) failed.set(entry.Key, entry.Code || "Unknown");
    }
    const unknown: string[] = [];
    const batchFailed: { key: string; code: string }[] = [];
    const batchDeleted: string[] = [];
    for (const key of batch) {
      const wasDeleted = deleted.has(key);
      const code = failed.get(key);
      if (wasDeleted && code) unknown.push(key);
      else if (code) batchFailed.push({ key, code });
      else if (wasDeleted) batchDeleted.push(key);
      else unknown.push(key);
    }
    for (const entry of response.Deleted ?? []) {
      if (entry.Key && !batch.includes(entry.Key)) unknown.push(entry.Key);
    }
    for (const key of batchDeleted) input.log(`deleted ${key}`);
    confirmed.push(...batchDeleted);
    for (const failure of batchFailed) input.log(`failed ${failure.key} ${failure.code}`);
    const failedText = batchFailed.map((failure) => `${failure.key} (${failure.code})`).join(", ");
    if (unknown.length > 0 || batchDeleted.length + batchFailed.length + unknown.length !== batch.length) {
      for (const key of unknown) input.log(`unknown ${key}`);
      throw new CatalogPruneRefusal(
        `Refusing catalog prune: delete response did not account for every requested key${failedText ? `; failed ${failedText}` : ""}; deleted so far ${confirmed.join(" ") || String(confirmed.length)}`,
      );
    }
    if (batchFailed.length > 0) {
      throw new CatalogPruneRefusal(
        `Refusing catalog prune: failed ${failedText}; deleted so far ${confirmed.join(" ")}`,
      );
    }
  }
}
