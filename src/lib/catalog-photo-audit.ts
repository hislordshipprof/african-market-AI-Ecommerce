import { isServableCatalogKey } from "./r2";
import { isRetiredRemote } from "./storefront/editorial";
import { catalogKeyFromUrl } from "./storefront/images";

export const MAX_HEAD_CONCURRENCY = 8;

export type AuditProduct = {
  id: string;
  name: string;
  status: string;
  imageUrl: string | null;
};

export type AuditStatus = "ok" | "missing" | "invalid-key" | "not-r2";

export type AuditRow = {
  status: AuditStatus;
  name: string;
  id: string;
  productStatus: string;
  key: string | null;
  ext: string | null;
  reason: string;
};

export type AuditCounts = {
  ok: number;
  missing: number;
  "invalid-key": number;
  "not-r2": number;
  "no-image": number;
  checkedKeys: number;
  missingExtensions: Record<string, number>;
};

export type HeadResult = "present" | "missing";

export class CatalogAuditError extends Error {
  readonly key?: string;
  readonly bucket?: string;
  readonly statusLabel: string;

  constructor(message: string, details: { key?: string; bucket?: string; statusLabel: string }) {
    super(message);
    this.name = "CatalogAuditError";
    this.key = details.key;
    this.bucket = details.bucket;
    this.statusLabel = details.statusLabel;
  }
}

const LOCAL_RETRY = /^\/api\/catalog-image\/(catalog\/[a-zA-Z0-9._-]+\.(?:jpg|png|webp))\?retry=1$/;

type Decision =
  | { kind: "no-image" }
  | { kind: "not-r2"; reason: string }
  | { kind: "invalid-key"; key: string; reason: string }
  | { kind: "check"; key: string };

export function assertConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined) return MAX_HEAD_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_HEAD_CONCURRENCY) {
    throw new CatalogAuditError("concurrency must be an integer from 1 to 8", { statusLabel: "concurrency" });
  }
  return concurrency;
}

function extensionOf(key: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(key);
  return match?.[1] ?? null;
}

function invalidCatalogReason(url: string): string {
  if (url.includes("?") || url.includes("#")) {
    return "local catalog URL is not a bare key or the allowlisted ?retry=1 query";
  }
  if (url.includes("..") || /\/catalog\/[^/]+\//.test(url) || /^catalog\/[^/]+\//.test(url)) {
    return "catalog path is not a single object key";
  }
  if (/\.[A-Z][A-Za-z0-9]*$/.test(url)) {
    return "extension is not a lowercase jpg, png, or webp catalog key";
  }
  return "catalog path is not a servable route key";
}

function decisionForKey(key: string): Decision {
  if (!isServableCatalogKey(key)) {
    return { kind: "invalid-key", key, reason: "route allowlist refuses this key" };
  }
  return { kind: "check", key };
}

/**
 * Audit classification. Whitespace-only skipping is audit-only.
 * `storefrontPhoto` still returns whitespace unchanged.
 * Remote URLs with a query or fragment are not rewritten into keys.
 */
export function classifyCatalogImage(imageUrl: string | null | undefined): Decision {
  if (imageUrl == null || imageUrl.trim() === "") return { kind: "no-image" };
  if (imageUrl.endsWith(".svg") || isRetiredRemote(imageUrl)) {
    return { kind: "not-r2", reason: "storefront hides this photo" };
  }
  const retry = LOCAL_RETRY.exec(imageUrl);
  if (retry?.[1]) return decisionForKey(retry[1]);
  const extracted = catalogKeyFromUrl(imageUrl);
  if (extracted) return decisionForKey(extracted);
  if (imageUrl.startsWith("/api/catalog-image/") || imageUrl.startsWith("catalog/")) {
    return { kind: "invalid-key", key: imageUrl, reason: invalidCatalogReason(imageUrl) };
  }
  return { kind: "not-r2", reason: "storefront returns this URL unchanged" };
}

function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object" || !("$metadata" in err)) return undefined;
  const metadata = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

export function statusLabel(err: unknown): string {
  const status = httpStatus(err);
  if (status !== undefined) return `HTTP ${status}`;
  const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "no status";
}

function failureFor(key: string, err: unknown): CatalogAuditError {
  if (err instanceof CatalogAuditError) return err;
  const label = statusLabel(err);
  return new CatalogAuditError(`HeadObject failed for ${key}: ${label}`, { key, statusLabel: label });
}

async function checkKeys(
  keys: string[],
  limit: number,
  headObject: (key: string) => Promise<HeadResult>,
): Promise<Map<string, HeadResult>> {
  const results = new Map<string, HeadResult>();
  let next = 0;
  let firstError: CatalogAuditError | null = null;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      if (index >= keys.length) return;
      next = index + 1;
      const key = keys[index]!;
      try {
        const result = await headObject(key);
        if (firstError) return;
        if (result !== "present" && result !== "missing") {
          throw new CatalogAuditError(`HeadObject failed for ${key}: unexpected result`, {
            key,
            statusLabel: "unexpected",
          });
        }
        results.set(key, result);
      } catch (err) {
        if (!firstError) firstError = failureFor(key, err);
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, keys.length) }, () => worker());
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

function compareRows(a: AuditRow, b: AuditRow): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export async function auditCatalogPhotos(input: {
  products: AuditProduct[];
  headObject: (key: string) => Promise<HeadResult>;
  concurrency?: number;
}): Promise<{ rows: AuditRow[]; counts: AuditCounts }> {
  const concurrency = assertConcurrency(input.concurrency);
  const counts: AuditCounts = {
    ok: 0,
    missing: 0,
    "invalid-key": 0,
    "not-r2": 0,
    "no-image": 0,
    checkedKeys: 0,
    missingExtensions: {},
  };
  const pending: Array<{ product: AuditProduct; decision: Exclude<Decision, { kind: "no-image" }> }> = [];
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const product of input.products) {
    const decision = classifyCatalogImage(product.imageUrl);
    if (decision.kind === "no-image") {
      counts["no-image"] += 1;
      continue;
    }
    pending.push({ product, decision });
    if (decision.kind === "check" && !seen.has(decision.key)) {
      seen.add(decision.key);
      keys.push(decision.key);
    }
  }

  const checked = keys.length === 0 ? new Map<string, HeadResult>() : await checkKeys(keys, concurrency, input.headObject);
  counts.checkedKeys = checked.size;

  const rows: AuditRow[] = [];
  for (const { product, decision } of pending) {
    if (decision.kind === "not-r2") {
      counts["not-r2"] += 1;
      rows.push({
        status: "not-r2",
        name: product.name,
        id: product.id,
        productStatus: product.status,
        key: null,
        ext: null,
        reason: decision.reason,
      });
      continue;
    }
    if (decision.kind === "invalid-key") {
      counts["invalid-key"] += 1;
      rows.push({
        status: "invalid-key",
        name: product.name,
        id: product.id,
        productStatus: product.status,
        key: decision.key,
        ext: extensionOf(decision.key),
        reason: decision.reason,
      });
      continue;
    }
    const result = checked.get(decision.key);
    if (!result) {
      throw new CatalogAuditError(`HeadObject failed for ${decision.key}: no status`, {
        key: decision.key,
        statusLabel: "no status",
      });
    }
    const ext = extensionOf(decision.key);
    if (result === "present") {
      counts.ok += 1;
      rows.push({
        status: "ok",
        name: product.name,
        id: product.id,
        productStatus: product.status,
        key: decision.key,
        ext,
        reason: "object exists",
      });
      continue;
    }
    counts.missing += 1;
    if (ext) counts.missingExtensions[ext] = (counts.missingExtensions[ext] ?? 0) + 1;
    rows.push({
      status: "missing",
      name: product.name,
      id: product.id,
      productStatus: product.status,
      key: decision.key,
      ext,
      reason: "R2 HeadObject returned 404",
    });
  }

  rows.sort(compareRows);
  return { rows, counts };
}

export function escapeField(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\|/g, "\\|")
    .replace(/[\u0000-\u001F\u007F]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function formatCatalogAuditReport(input: {
  rows: AuditRow[];
  counts: AuditCounts;
  dbReadAt: Date;
  completedAt: Date;
  dbHost: string;
  bucket: string;
}): string {
  const lines = input.rows.map((row) =>
    [row.status, row.name, row.id, row.productStatus, row.key ?? "", row.ext ?? "", row.reason]
      .map(escapeField)
      .join(" | "),
  );
  const extensions = Object.keys(input.counts.missingExtensions)
    .sort()
    .map((ext) => `${escapeField(ext)}=${input.counts.missingExtensions[ext]}`);
  lines.push(
    `counts ok=${input.counts.ok} missing=${input.counts.missing} invalid-key=${input.counts["invalid-key"]} not-r2=${input.counts["not-r2"]} no-image=${input.counts["no-image"]}`,
    `missing-extensions ${extensions.length > 0 ? extensions.join(" ") : "none"}`,
    `${input.counts.checkedKeys} checked`,
    `db-read: ${input.dbReadAt.toISOString()}`,
    `completed: ${input.completedAt.toISOString()}`,
    `db-host: ${escapeField(input.dbHost)}`,
    `bucket: ${escapeField(input.bucket)}`,
    "note: R2 results are observations between db-read and completed, not an atomic snapshot",
    "",
  );
  return lines.join("\n");
}
