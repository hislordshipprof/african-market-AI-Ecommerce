import {
  auditCatalogPhotos,
  formatCatalogAuditReport,
  type AuditProduct,
  type HeadResult,
} from "./catalog-photo-audit";
import { redactSecrets, secretsInEnv, validateRuntimeEnv, type RuntimeConfig } from "./catalog-photo-audit-env";
import { writeComplete } from "./catalog-photo-audit-io";

export type AuditDeps = {
  readProducts: () => Promise<AuditProduct[]>;
  openR2: () => Promise<{
    bucket: string;
    headBucket: () => Promise<void>;
    headObject: (key: string) => Promise<HeadResult>;
  }>;
  close: () => Promise<void>;
};

/**
 * Loads the runtime reader and the R2 adapter after env validation.
 * The db module reads process.env when it is imported. The CLI validates
 * that same env and does not mutate it, so the login URL and the header agree.
 * DIRECT_URL is not read.
 */
export async function loadAuditDeps(config: RuntimeConfig): Promise<AuditDeps> {
  const [{ readMasterProductsForPhotoAudit, disconnectPhotoAudit }, { createR2HeadObject }] = await Promise.all([
    import("./catalog-photo-audit-reader"),
    import("./catalog-photo-audit-r2"),
  ]);
  let head: { close: () => void } | undefined;
  return {
    readProducts: () => readMasterProductsForPhotoAudit(),
    openR2: () => {
      const opened = createR2HeadObject({
        accountId: config.accountId,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        bucket: config.bucket,
      });
      head = opened;
      return Promise.resolve(opened);
    },
    close: async () => {
      head?.close();
      await disconnectPhotoAudit();
    },
  };
}

export async function main(options: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  loadDeps: (config: RuntimeConfig) => Promise<AuditDeps>;
  now?: () => Date;
}): Promise<number> {
  const validated = validateRuntimeEnv(options.env);
  if (!validated.ok) {
    await writeComplete(options.stderr, validated.message);
    return 1;
  }
  const config = validated.config;
  const now = options.now ?? (() => new Date());
  const secrets = secretsInEnv(options.env);
  let deps: AuditDeps | undefined;
  try {
    try {
      deps = await options.loadDeps(config);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "audit failed";
      await writeComplete(options.stderr, `${redactSecrets(detail, secrets)}\n`);
      return 1;
    }
    let products: AuditProduct[];
    try {
      products = await deps.readProducts();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "read failed";
      await writeComplete(options.stderr, `Database read failed: ${redactSecrets(detail, secrets)}\n`);
      return 1;
    }
    const dbReadAt = now();
    let head: Awaited<ReturnType<AuditDeps["openR2"]>>;
    try {
      head = await deps.openR2();
      await head.headBucket();
    } catch (err) {
      const message = err instanceof Error ? err.message : "HeadBucket failed";
      await writeComplete(options.stderr, `${redactSecrets(message, secrets)}\n`);
      return 1;
    }
    let report: { rows: Awaited<ReturnType<typeof auditCatalogPhotos>>["rows"]; counts: Awaited<ReturnType<typeof auditCatalogPhotos>>["counts"] };
    try {
      report = await auditCatalogPhotos({ products, headObject: head.headObject });
    } catch (err) {
      const message = err instanceof Error ? err.message : "HeadObject failed";
      await writeComplete(options.stderr, `${redactSecrets(message, secrets)}\n`);
      return 1;
    }
    const completedAt = now();
    const text = formatCatalogAuditReport({
      rows: report.rows,
      counts: report.counts,
      dbReadAt,
      completedAt,
      dbHost: config.databaseHost,
      bucket: config.bucket,
    });
    try {
      await writeComplete(options.stdout, text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "write failed";
      await writeComplete(options.stderr, `Output write failed: ${redactSecrets(detail, secrets)}\n`).catch(() => undefined);
      return 1;
    }
    return 0;
  } finally {
    await deps?.close().catch(() => undefined);
  }
}
