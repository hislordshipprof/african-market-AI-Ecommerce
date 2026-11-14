import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformAdminTransaction } from "./db";
import {
  deletePhotoAuditIds,
  deletePhotoAuditRun,
  insertNamedPhotoAuditFixtures,
  photoAuditRunIds,
} from "./catalog-photo-audit-fixtures";
import {
  photoAuditLoginRole,
  photoAuditMasterProduct,
  readMasterProductsForPhotoAudit,
} from "./catalog-photo-audit-reader";
import { runtimeDatabaseUrl } from "./env";

const hasRuntime = !!process.env.DATABASE_URL && !!process.env.APP_RUNTIME_PASSWORD;

function newRunPrefix(): string {
  return `t224${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

const run = newRunPrefix();
const named = {
  active: `${run}-active`,
  inactive: `${run}-inactive`,
  rejected: `${run}-rejected`,
};
const bulkIds = Array.from({ length: 1001 }, (_, index) => `${run}-b${index}`);
const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const worker = path.join(process.cwd(), "src", "lib", "catalog-photo-audit-run-worker.ts");

function redact(text: string): string {
  let out = text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]");
  const secrets = [process.env.DATABASE_URL, process.env.DIRECT_URL, process.env.APP_RUNTIME_PASSWORD];
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function runWorker(command: "insert" | "delete", prefix: string): Promise<void> {
  const child = spawn(process.execPath, [tsxCli, worker, command, prefix], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(redact(`worker ${command} timed out`)));
    }, 20000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(redact(`worker ${command} ${prefix} exited ${code}: ${stderr}`)));
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe.skipIf(!hasRuntime)("catalog photo audit reader", () => {
  beforeAll(async () => {
    await platformAdminTransaction(async (tx) => {
      await insertNamedPhotoAuditFixtures(tx, run);
    });
  });

  afterAll(async () => {
    await deletePhotoAuditRun(run);
    const rows = await readMasterProductsForPhotoAudit();
    const leaked = rows.filter((row) =>
      row.id === named.active
      || row.id === named.inactive
      || row.id === named.rejected
      || row.id === `${run}-blocked`
      || bulkIds.includes(row.id),
    );
    expect(leaked).toEqual([]);
  });

  it("reader returns every seeded master product, including inactive and rejected (AC5)", async () => {
    const rows = await readMasterProductsForPhotoAudit();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(named.active)).toMatchObject({
      status: "active",
      imageUrl: "/api/catalog-image/catalog/active.webp",
    });
    expect(byId.get(named.inactive)).toMatchObject({ status: "inactive" });
    expect(byId.get(named.rejected)).toMatchObject({ status: "rejected", imageUrl: null });
  });

  it("real reader returns more than 1000 fixture rows across all statuses (E34)", async () => {
    await platformAdminTransaction(async (tx) => {
      for (let offset = 0; offset < bulkIds.length; offset += 400) {
        const slice = bulkIds.slice(offset, offset + 400);
        await tx.masterProduct.createMany({
          data: slice.map((id, index) => {
            const n = offset + index;
            return {
              id,
              name: `${run} bulk ${n}`,
              status: n % 3 === 0 ? "active" : n % 3 === 1 ? "inactive" : "rejected",
              imageUrl: n % 5 === 0 ? null : `/api/catalog-image/catalog/${run}-${n}.webp`,
            };
          }),
        });
      }
    });
    const rows = await readMasterProductsForPhotoAudit();
    const found = new Set(rows.map((row) => row.id));
    const missing = bulkIds.filter((id) => !found.has(id));
    expect(missing).toEqual([]);
    expect(bulkIds.length).toBeGreaterThan(1000);
  });

  it("actual reader dependency denies writes to known existing fixture rows (AC5, E5)", async () => {
    const login = new URL(runtimeDatabaseUrl(process.env));
    expect(login.username).toBe("app_runtime");
    expect(await photoAuditLoginRole()).toBe("app_runtime");

    const before = await readMasterProductsForPhotoAudit();
    const active = before.find((row) => row.id === named.active);
    const inactive = before.find((row) => row.id === named.inactive);
    const rejected = before.find((row) => row.id === named.rejected);
    expect(active?.name).toBe(`${run} active`);
    expect(inactive?.id).toBe(named.inactive);
    expect(rejected?.id).toBe(named.rejected);

    const delegate = photoAuditMasterProduct();
    await expect(delegate.create({
      data: { id: `${run}-blocked`, name: `${run} blocked`, status: "active" },
    })).rejects.toThrow(/42501|row-level security/i);

    const updated = await delegate.updateMany({
      where: { id: { in: [named.active, named.inactive, named.rejected] } },
      data: { name: `${run} hacked` },
    });
    expect(updated.count).toBe(0);

    const deleted = await delegate.deleteMany({
      where: { id: { in: [named.active, named.inactive, named.rejected] } },
    });
    expect(deleted.count).toBe(0);

    const after = await readMasterProductsForPhotoAudit();
    expect(after.find((row) => row.id === named.active)?.name).toBe(`${run} active`);
    expect(after.find((row) => row.id === named.inactive)?.name).toBe(`${run} inactive`);
    expect(after.find((row) => row.id === named.rejected)?.name).toBe(`${run} rejected`);
    expect(after.find((row) => row.id === `${run}-blocked`)).toBeUndefined();
  });

  it("named setup rolls back after a partial insert failure", async () => {
    const prefix = newRunPrefix();
    const ids = photoAuditRunIds(prefix);
    try {
      await expect(platformAdminTransaction(async (tx) => {
        await insertNamedPhotoAuditFixtures(tx, prefix, 1);
      })).rejects.toThrow("injected partial failure");
      const rows = await readMasterProductsForPhotoAudit();
      expect(rows.find((row) => row.id === ids.named.active)).toBeUndefined();
      expect(rows.find((row) => row.id === ids.named.inactive)).toBeUndefined();
      expect(rows.find((row) => row.id === ids.named.rejected)).toBeUndefined();
    } finally {
      await deletePhotoAuditRun(prefix);
    }
  });

  it("cleanup removes attempted denied-write IDs after failure and is idempotent", async () => {
    const prefix = newRunPrefix();
    const ids = photoAuditRunIds(prefix);
    const sentinel = `${prefix}-sentinel`;
    try {
      await platformAdminTransaction(async (tx) => {
        await tx.masterProduct.create({
          data: { id: ids.blocked, name: `${prefix} blocked`, status: "active" },
        });
        await tx.masterProduct.create({
          data: { id: sentinel, name: `${prefix} sentinel`, status: "active", imageUrl: null },
        });
      });
      await deletePhotoAuditRun(prefix);
      await deletePhotoAuditRun(prefix);
      const rows = await readMasterProductsForPhotoAudit();
      expect(rows.find((row) => row.id === ids.blocked)).toBeUndefined();
      expect(rows.find((row) => row.id === sentinel)).toMatchObject({
        name: `${prefix} sentinel`,
        status: "active",
        imageUrl: null,
      });
      expect(rows.find((row) => row.id === named.active)?.name).toBe(`${run} active`);
    } finally {
      await deletePhotoAuditRun(prefix);
      await deletePhotoAuditIds([sentinel]);
    }
  });

  it("a second run on the same database removes only its own rows", async () => {
    const first = newRunPrefix();
    const second = newRunPrefix();
    try {
      await runWorker("insert", first);
      await runWorker("delete", first);
      await runWorker("insert", second);
      const mid = await readMasterProductsForPhotoAudit();
      expect(mid.find((row) => row.id === `${first}-active`)).toBeUndefined();
      expect(mid.find((row) => row.id === `${first}-inactive`)).toBeUndefined();
      expect(mid.find((row) => row.id === `${first}-rejected`)).toBeUndefined();
      expect(mid.find((row) => row.id === `${second}-active`)).toMatchObject({
        name: `${second} active`,
        status: "active",
        imageUrl: "/api/catalog-image/catalog/active.webp",
      });
      expect(mid.find((row) => row.id === named.active)?.name).toBe(`${run} active`);
      await runWorker("delete", second);
      const after = await readMasterProductsForPhotoAudit();
      expect(after.find((row) => row.id === `${second}-active`)).toBeUndefined();
      expect(after.find((row) => row.id === `${second}-inactive`)).toBeUndefined();
      expect(after.find((row) => row.id === `${second}-rejected`)).toBeUndefined();
      expect(after.find((row) => row.id === named.active)?.name).toBe(`${run} active`);
    } finally {
      await deletePhotoAuditRun(first);
      await deletePhotoAuditRun(second);
    }
  }, 30_000);

  it("cleanup preserves another live run and unrelated rows", async () => {
    const prefixA = newRunPrefix();
    const prefixB = newRunPrefix();
    const sentinel = `${prefixA}sentinel`;
    expect(prefixA).not.toBe(prefixB);
    expect(prefixA).not.toBe(run);
    expect(photoAuditRunIds(prefixA).cleanupIds).not.toContain(sentinel);
    try {
      await platformAdminTransaction(async (tx) => {
        await tx.masterProduct.create({
          data: { id: sentinel, name: `${prefixA} sentinel`, status: "rejected", imageUrl: null },
        });
      });
      await Promise.all([runWorker("insert", prefixA), runWorker("insert", prefixB)]);
      const live = await readMasterProductsForPhotoAudit();
      expect(live.find((row) => row.id === `${prefixA}-active`)).toMatchObject({
        name: `${prefixA} active`,
        status: "active",
      });
      expect(live.find((row) => row.id === `${prefixB}-inactive`)).toMatchObject({
        name: `${prefixB} inactive`,
        status: "inactive",
      });
      expect(live.find((row) => row.id === sentinel)).toMatchObject({
        name: `${prefixA} sentinel`,
        status: "rejected",
        imageUrl: null,
      });

      await runWorker("delete", prefixA);
      const after = await readMasterProductsForPhotoAudit();
      expect(after.find((row) => row.id === `${prefixA}-active`)).toBeUndefined();
      expect(after.find((row) => row.id === `${prefixA}-inactive`)).toBeUndefined();
      expect(after.find((row) => row.id === `${prefixA}-rejected`)).toBeUndefined();
      expect(after.find((row) => row.id === `${prefixA}-blocked`)).toBeUndefined();
      expect(after.find((row) => row.id === `${prefixB}-active`)).toMatchObject({
        name: `${prefixB} active`,
        status: "active",
        imageUrl: "/api/catalog-image/catalog/active.webp",
      });
      expect(after.find((row) => row.id === `${prefixB}-inactive`)).toMatchObject({
        name: `${prefixB} inactive`,
        status: "inactive",
        imageUrl: "/api/catalog-image/catalog/inactive.webp",
      });
      expect(after.find((row) => row.id === `${prefixB}-rejected`)).toMatchObject({
        name: `${prefixB} rejected`,
        status: "rejected",
        imageUrl: null,
      });
      expect(after.find((row) => row.id === sentinel)).toMatchObject({
        name: `${prefixA} sentinel`,
        status: "rejected",
        imageUrl: null,
      });
      expect(after.find((row) => row.id === named.active)?.name).toBe(`${run} active`);

      await runWorker("delete", prefixA);
      const repeated = await readMasterProductsForPhotoAudit();
      expect(repeated.find((row) => row.id === `${prefixB}-active`)?.name).toBe(`${prefixB} active`);
      expect(repeated.find((row) => row.id === sentinel)?.name).toBe(`${prefixA} sentinel`);
    } finally {
      await deletePhotoAuditRun(prefixA);
      await deletePhotoAuditRun(prefixB);
      await deletePhotoAuditIds([sentinel]);
    }
  }, 30_000);
});
