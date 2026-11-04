/** Pure catalog-prune decisions. No I/O. */

export const CATALOG_PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const CATALOG_PRUNE_BATCH_SIZE = 1000;
export const CATALOG_PREFIX = "catalog/";

const R2_KEY_NAMES = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

export class CatalogPruneRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogPruneRefusal";
  }
}

export type DatabaseIdentity = {
  host: string;
  port: string;
  database: string;
};

export type OwnershipBinding = {
  accountId: string;
  bucket: string;
  databases: { host: string; database: string }[];
};

export type PruneDecision =
  | { mode: "off" }
  | { mode: "dry-run" }
  | { mode: "delete" }
  | { refused: string };

export type ListedObject = {
  key: string;
  lastModified: Date | null;
};

type Env = Record<string, string | undefined>;

export function catalogPruneMode(input: {
  env: Env;
  databaseUrl: string | null;
  observed?: DatabaseIdentity | null;
  ownership?: OwnershipBinding[];
  writersCoordinated?: boolean;
  /**
   * Addresses of each URL hostname, from a DNS lookup of the connection string.
   * PostgreSQL reports inet_server_addr() as an IP, so a Neon hostname matches
   * when that IP is one of these addresses. Failed lookups leave the list empty
   * and the connection is refused.
   */
  resolvedHosts?: Readonly<Record<string, readonly string[]>>;
}): PruneDecision {
  const raw = input.env.SEED_PRUNE_R2;
  if (raw === undefined || raw.trim() === "") return { mode: "off" };

  const envReason = environmentRefusal(input.env);
  if (envReason) return { refused: envReason };

  const missing = R2_KEY_NAMES.filter((name) => !input.env[name]);
  if (missing.length > 0) {
    return { refused: `Refusing catalog prune: missing ${missing.join(", ")}` };
  }

  const bucket = input.env.R2_BUCKET ?? "";
  let mode: "dry-run" | "delete";
  if (raw === "dry-run") mode = "dry-run";
  else if (raw === bucket) mode = "delete";
  else {
    return {
      refused:
        "Refusing catalog prune: SEED_PRUNE_R2 must be dry-run or the R2_BUCKET value. Accepted forms: dry-run, or the R2_BUCKET value.",
    };
  }

  const target = databaseTarget(input.databaseUrl, input.observed, input.resolvedHosts);
  if ("refused" in target) return target;

  if (mode === "dry-run") return { mode: "dry-run" };

  const ownership = input.ownership ?? [];
  const owned = ownership.find(
    (binding) =>
      binding.accountId === input.env.R2_ACCOUNT_ID && binding.bucket === bucket,
  );
  if (!owned) {
    return {
      refused:
        "Refusing catalog prune: no authoritative ownership binding for R2_BUCKET on the connected database",
    };
  }
  if (owned.databases.length !== 1) {
    return {
      refused:
        "Refusing catalog prune: R2_BUCKET is shared by more than one database and this process cannot cover every owner",
    };
  }
  const only = owned.databases[0]!;
  if (
    !hostsMatch(only.host, target.identity.host, input.resolvedHosts) ||
    only.database !== target.identity.database
  ) {
    return {
      refused:
        "Refusing catalog prune: the ownership binding does not match the connected database",
    };
  }
  if (!input.writersCoordinated) {
    return {
      refused:
        "Refusing catalog prune: catalog writers are not coordinated for the scan-to-delete interval",
    };
  }
  return { mode: "delete" };
}

export function databaseIdentityFromUrl(url: string): DatabaseIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") return null;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database || !parsed.hostname) return null;
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database,
  };
}

export function planCatalogPrune(input: {
  objects: ListedObject[];
  references: string[];
  now: Date;
  minAgeMs?: number;
}): string[] {
  if (input.references.some((reference) => !referenceDecodes(reference))) {
    throw new CatalogPruneRefusal(
      "Refusing catalog prune: a stored reference could not be decoded safely",
    );
  }
  const minAgeMs = input.minAgeMs ?? CATALOG_PRUNE_MIN_AGE_MS;
  const eligible = new Map<string, boolean>();
  for (const object of input.objects) {
    if (!object.key.startsWith(CATALOG_PREFIX) || object.key.endsWith(".webp")) continue;
    const old = olderThan(object.lastModified, input.now, minAgeMs);
    const previous = eligible.get(object.key);
    if (previous === undefined) eligible.set(object.key, old);
    else if (!old) eligible.set(object.key, false);
  }
  const candidates: string[] = [];
  for (const [key, old] of eligible) {
    if (!old) continue;
    if (input.references.some((reference) => referenceProtects(reference, key))) continue;
    candidates.push(key);
  }
  return candidates;
}

export function referenceProtects(reference: string, key: string): boolean {
  if (reference.includes(key)) return true;
  const encodedDot = key.replaceAll(".", "%2E");
  const encodedDotLower = key.replaceAll(".", "%2e");
  if (reference.includes(encodedDot) || reference.includes(encodedDotLower)) return true;
  let current = reference;
  for (let i = 0; i < 3; i++) {
    if (!current.includes("%")) break;
    try {
      const next = decodeURIComponent(current);
      if (next.includes(key)) return true;
      if (next === current) break;
      current = next;
    } catch {
      return true;
    }
  }
  return false;
}

export function missingUpsertedIds(presentIds: readonly string[], upsertedIds: readonly string[]): string[] {
  const present = new Set(presentIds);
  const missing: string[] = [];
  for (const id of new Set(upsertedIds)) {
    if (!present.has(id)) missing.push(id);
  }
  return missing;
}

export function chunkCatalogKeys(keys: readonly string[], size = CATALOG_PRUNE_BATCH_SIZE): string[][] {
  if (size < 1 || size > CATALOG_PRUNE_BATCH_SIZE) {
    throw new CatalogPruneRefusal("Refusing catalog prune: batch size must be from 1 to 1000");
  }
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += size) batches.push(keys.slice(i, i + size));
  return batches;
}

function environmentRefusal(env: Env): string | null {
  if (nonEmpty(env.CI)) return "Refusing catalog prune: CI is set";
  if (nonEmpty(env.VERCEL)) return "Refusing catalog prune: VERCEL is set";
  if (env.NODE_ENV === "production") return "Refusing catalog prune: NODE_ENV is production";
  if (env.VERCEL_ENV === "production") return "Refusing catalog prune: VERCEL_ENV is production";
  if (env.VERCEL_ENV === "preview") return "Refusing catalog prune: VERCEL_ENV is preview";
  const e2e = Object.keys(env)
    .filter((key) => key.startsWith("E2E_") && nonEmpty(env[key]))
    .sort();
  if (e2e.length > 0) return `Refusing catalog prune: ${e2e[0]} is set`;
  return null;
}

function databaseTarget(
  databaseUrl: string | null,
  observed: DatabaseIdentity | null | undefined,
  resolvedHosts?: Readonly<Record<string, readonly string[]>>,
): { identity: DatabaseIdentity } | { refused: string } {
  if (!databaseUrl) {
    return { refused: "Refusing catalog prune: database URL is missing or malformed" };
  }
  const fromUrl = databaseIdentityFromUrl(databaseUrl);
  if (!fromUrl) {
    return { refused: "Refusing catalog prune: database URL is missing or malformed" };
  }
  const local = localRefusal(fromUrl);
  if (local) return { refused: local };
  if (!observed) {
    return { refused: "Refusing catalog prune: the effective database connection was not observed" };
  }
  const observedLocal = localRefusal(observed);
  if (observedLocal) return { refused: observedLocal };
  if (
    !hostsMatch(fromUrl.host, observed.host, resolvedHosts) ||
    fromUrl.port !== observed.port ||
    fromUrl.database !== observed.database
  ) {
    return {
      refused:
        "Refusing catalog prune: the resolved direct connection does not match the connected database",
    };
  }
  return { identity: observed };
}

function localRefusal(identity: DatabaseIdentity): string | null {
  if (isLoopback(identity.host)) {
    return `Refusing catalog prune: database host is ${identity.host}`;
  }
  if (identity.database.startsWith("lane_")) {
    return "Refusing catalog prune: database name starts with lane_";
  }
  return null;
}

function olderThan(lastModified: Date | null, now: Date, minAgeMs: number): boolean {
  if (!(lastModified instanceof Date) || Number.isNaN(lastModified.getTime())) return false;
  if (Number.isNaN(now.getTime())) return false;
  return now.getTime() - lastModified.getTime() > minAgeMs;
}

function referenceDecodes(reference: string): boolean {
  if (!reference.includes("%")) return true;
  try {
    let current = reference;
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(current);
      if (next === current) return true;
      current = next;
    }
    return true;
  } catch {
    return false;
  }
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function hostsMatch(
  left: string,
  right: string,
  resolvedHosts?: Readonly<Record<string, readonly string[]>>,
): boolean {
  if (isLoopback(left) && isLoopback(right)) return true;
  if (normalizeHost(left) === normalizeHost(right)) return true;
  const observed = normalizeHost(right);
  const addresses = resolvedHosts?.[left] ?? resolvedHosts?.[normalizeHost(left)] ?? [];
  return addresses.some((address) => normalizeHost(address) === observed);
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
