import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

vi.mock("./session", () => ({
  requirePlatformAdmin: vi.fn().mockResolvedValue({
    user: { id: "catalog-test-admin", email: "catalog-admin@platform.test", role: "platform_admin", twoFactorEnabled: true },
  }),
}));

import {
  approveProduct,
  rejectProduct,
  updateReviewProduct,
  listReviewProducts,
  getReviewStats,
} from "./catalog-actions";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t125-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!hasDb)("Catalog review actions (DB integration)", () => {
  let raw: PrismaClient;
  const createdIds: string[] = [];

  async function seed(name: string, status = "needs_review", extra: Record<string, unknown> = {}) {
    const p = await raw.masterProduct.create({ data: { name: `${RUN} ${name}`, status, ...extra } });
    createdIds.push(p.id);
    return p;
  }
  const audits = (id: string, action: string) =>
    raw.auditLog.findMany({ where: { entityId: id, action } });

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await raw.$connect();
    await raw.user.upsert({
      where: { email: "catalog-admin@platform.test" },
      update: {},
      create: { id: "catalog-test-admin", email: "catalog-admin@platform.test", name: "Catalog Test Admin", emailVerified: true },
    });
  });

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { entityId: { in: createdIds } } }).catch(() => {});
    await raw.masterProduct.deleteMany({ where: { id: { in: createdIds } } });
    await raw.user.deleteMany({ where: { id: "catalog-test-admin" } }).catch(() => {});
    await raw.$disconnect();
  });

  it("approve: needs_review -> active with one catalog.approve audit row", async () => {
    const p = await seed("approve");
    expect(await approveProduct(p.id)).toEqual({ success: true });
    const after = await raw.masterProduct.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("active");
    expect(await audits(p.id, "catalog.approve")).toHaveLength(1);
  });

  it("approve: unknown product returns an error", async () => {
    expect(await approveProduct("does-not-exist")).toEqual({ error: "Product not found" });
  });

  it("reject: needs_review -> rejected with one catalog.reject audit row", async () => {
    const p = await seed("reject");
    expect(await rejectProduct(p.id)).toEqual({ success: true });
    const after = await raw.masterProduct.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("rejected");
    expect(await audits(p.id, "catalog.reject")).toHaveLength(1);
  });

  it("update: changes fields and audits before/after", async () => {
    const p = await seed("update", "needs_review", { description: "old desc" });
    expect(await updateReviewProduct(p.id, { name: "New Name", description: "New desc" })).toEqual({ success: true });
    const after = await raw.masterProduct.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.name).toBe("New Name");
    expect(after.description).toBe("New desc");
    const rows = await audits(p.id, "catalog.edit");
    expect(rows).toHaveLength(1);
    expect(rows[0].before).toMatchObject({ name: `${RUN} update`, description: "old desc" });
    expect(rows[0].after).toMatchObject({ name: "New Name", description: "New desc" });
  });

  it.each(["", "   "])("update: rejects blank name %j and changes nothing", async (name) => {
    const p = await seed("blank");
    expect(await updateReviewProduct(p.id, { name })).toEqual({ error: "Name is required" });
    const after = await raw.masterProduct.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.name).toBe(`${RUN} blank`);
    expect(await audits(p.id, "catalog.edit")).toHaveLength(0);
  });

  it("list: filters by status with correct total/page/pageSize", async () => {
    const tag = `${RUN}-list`;
    await seed("l1", `${tag}-active`);
    await seed("l2", `${tag}-review`);
    await seed("l3", `${tag}-rejected`);
    const res = await listReviewProducts({ status: `${tag}-review`, page: 1, pageSize: 10 });
    expect(res.products).toHaveLength(1);
    expect(res.products[0].name).toBe(`${RUN} l2`);
    expect(res).toMatchObject({ total: 1, page: 1, pageSize: 10 });
  });

  it("stats: counts reflect seeded rows", async () => {
    const before = await getReviewStats();
    await seed("s1", "needs_review");
    await seed("s2", "needs_review");
    await seed("s3", "active");
    await seed("s4", "rejected");
    const after = await getReviewStats();
    expect(after.needsReview - before.needsReview).toBe(2);
    expect(after.active - before.active).toBe(1);
    expect(after.rejected - before.rejected).toBe(1);
    expect(after.total).toBe(after.needsReview + after.active + after.rejected);
  });

  it("concurrent approve: exactly one audit row, product active (TOCTOU closed)", async () => {
    const p = await seed("race");
    const results = await Promise.all([approveProduct(p.id), approveProduct(p.id), approveProduct(p.id)]);
    expect(results.every((r) => r.success)).toBe(true);
    const after = await raw.masterProduct.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("active");
    expect(await audits(p.id, "catalog.approve")).toHaveLength(1);
  });

  it("concurrent approve + reject: both serialize, final status matches the later audit row", async () => {
    const p = await seed("race2");
    await Promise.all([approveProduct(p.id), rejectProduct(p.id)]);
    const after = await raw.masterProduct.findUniqueOrThrow({ where: { id: p.id } });
    const rows = await raw.auditLog.findMany({
      where: { entityId: p.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    const last = rows[rows.length - 1].action;
    expect(after.status).toBe(last === "catalog.approve" ? "active" : "rejected");
  });
});
