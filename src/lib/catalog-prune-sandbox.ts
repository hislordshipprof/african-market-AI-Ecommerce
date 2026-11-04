import { randomUUID } from "node:crypto";
import { planCatalogPrune } from "./catalog-prune";
import { deleteCatalogCandidates, listCatalogObjects } from "./catalog-prune-execute";
import type { R2SendClient } from "./catalog-prune-fake-r2";

/** A unique prefix so two sandbox runs cannot share a manifest. */
export function sandboxRunPrefix(): string {
  return `catalog/prune-sandbox/${randomUUID()}/`;
}

/**
 * Delete only keys this run successfully created. A foreign object that happens
 * to share the prefix is left in place, including when an earlier step failed.
 */
export async function cleanupSandboxManifest(input: {
  client: R2SendClient;
  bucket: string;
  prefix: string;
  created: readonly string[];
  log?: (line: string) => void;
}): Promise<string[]> {
  const listed = await listCatalogObjects(input.client, input.bucket, input.prefix);
  const allowed = new Set(input.created);
  const keys = listed.map((object) => object.key).filter((key) => allowed.has(key));
  if (keys.length > 0) {
    await deleteCatalogCandidates({
      client: input.client,
      bucket: input.bucket,
      keys,
      log: input.log ?? (() => undefined),
    });
  }
  return keys;
}

/** Plan and delete candidates from this run's created keys only. */
export async function pruneSandboxManifest(input: {
  client: R2SendClient;
  bucket: string;
  prefix: string;
  created: readonly string[];
  references: readonly string[];
  now: Date;
  log?: (line: string) => void;
}): Promise<string[]> {
  const listed = await listCatalogObjects(input.client, input.bucket, input.prefix);
  const allowed = new Set(input.created);
  const candidates = planCatalogPrune({
    objects: listed.filter((object) => allowed.has(object.key)),
    references: [...input.references],
    now: input.now,
  });
  await deleteCatalogCandidates({
    client: input.client,
    bucket: input.bucket,
    keys: candidates,
    log: input.log ?? (() => undefined),
  });
  return candidates;
}
