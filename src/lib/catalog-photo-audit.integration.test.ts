import { afterAll, describe, expect, it } from "vitest";
import { platformAdminTransaction } from "./db";
import {
  photoAuditLoginRole,
  photoAuditMasterProduct,
  readMasterProductsForPhotoAudit,
} from "./catalog-photo-audit-reader";
import { runtimeDatabaseUrl } from "./env";

const hasRuntime = !!process.env.DATABASE_URL && !!process.env.APP_RUNTIME_PASSWORD;
const run = `t209${Date.now().toString(36)}`;
const named = {
  active: `${run}-active`,
  inactive: `${run}-inactive`,
  rejected: `${run}-rejected`,
};
const bulkIds = Array.from({ length: 1001 }, (_, index) => `${run}-b${index}`);
const allIds = [named.active, named.inactive, named.rejected, ...bulkIds];

async function deleteFixtures() {
  await platformAdminTransaction(async (tx) => {
    await tx.masterProduct.deleteMany({ where: { id: { in: allIds } } });
  });
}

describe.skipIf(!hasRuntime)("catalog photo audit reader", () => {
  afterAll(async () => {
    await deleteFixtures();
  });

  it("reader returns every seeded master product, including inactive and rejected (AC5)", async () => {
    await platformAdminTransaction(async (tx) => {
      await tx.masterProduct.create({
        data: { id: named.active, name: `${run} active`, status: "active", imageUrl: "/api/catalog-image/catalog/active.webp" },
      });
      await tx.masterProduct.create({
        data: { id: named.inactive, name: `${run} inactive`, status: "inactive", imageUrl: "/api/catalog-image/catalog/inactive.webp" },
      });
      await tx.masterProduct.create({
        data: { id: named.rejected, name: `${run} rejected`, status: "rejected", imageUrl: null },
      });
    });
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
});
