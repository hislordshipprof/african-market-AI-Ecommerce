/**
 * Read-only catalog photo audit.
 * Run: dotenv -e .env.local -- tsx scripts/audit-catalog-photos.ts
 *
 * Env is checked before the db module or the R2 client is imported.
 * S3 calls are HeadBucket and HeadObject only. No database writes.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { redactSecrets, secretsInEnv, validateRuntimeEnv, type RuntimeConfig } from "../src/lib/catalog-photo-audit-env";
import { finishProcess, writeComplete } from "../src/lib/catalog-photo-audit-io";
import type { AuditDeps } from "../src/lib/catalog-photo-audit-cli";

async function selectDeps(config: RuntimeConfig): Promise<AuditDeps> {
  const fixture = process.env.CATALOG_PHOTO_AUDIT_FIXTURE;
  if (fixture) {
    if (!path.isAbsolute(fixture)) {
      throw new Error("CATALOG_PHOTO_AUDIT_FIXTURE must be an absolute path");
    }
    const loaded = await import(pathToFileURL(fixture).href) as {
      loadDeps: (config: RuntimeConfig) => Promise<AuditDeps>;
    };
    return loaded.loadDeps(config);
  }
  const { loadAuditDeps } = await import("../src/lib/catalog-photo-audit-cli");
  return loadAuditDeps(config);
}

async function run(): Promise<void> {
  const validated = validateRuntimeEnv(process.env);
  if (!validated.ok) {
    await writeComplete(process.stderr, validated.message);
    finishProcess(1);
  }
  const { main } = await import("../src/lib/catalog-photo-audit-cli");
  const code = await main({
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    loadDeps: selectDeps,
  });
  finishProcess(code);
}

run().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : "audit failed";
  const text = redactSecrets(message, secretsInEnv(process.env));
  await writeComplete(process.stderr, `${text}\n`).catch(() => undefined);
  finishProcess(1);
});
