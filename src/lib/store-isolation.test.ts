import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped, platform } from "./db";
import { runtimeDatabaseUrl } from "./env";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Store isolation (RLS) via storeScoped", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "test-store-a" },
      update: {},
      create: {
        slug: "test-store-a",
        name: "Test Store A",
        themePreset: "palm-and-shea",
      },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "test-store-b" },
      update: {},
      create: {
        slug: "test-store-b",
        name: "Test Store B",
        themePreset: "lagoon-and-coral",
      },
    });
    storeBId = storeB.id;

    const scopedA = storeScoped(storeAId);
    await scopedA.rlsTestFixture.upsert({
      where: { storeId_key: { storeId: storeAId, key: "test_key" } },
      update: { value: "Store A value" },
      create: { storeId: storeAId, key: "test_key", value: "Store A value" },
    });

    const scopedB = storeScoped(storeBId);
    await scopedB.rlsTestFixture.upsert({
      where: { storeId_key: { storeId: storeBId, key: "test_key" } },
      update: { value: "Store B value" },
      create: { storeId: storeBId, key: "test_key", value: "Store B value" },
    });
  });

  afterAll(async () => {
    const scopedA = storeScoped(storeAId);
    await scopedA.rlsTestFixture.deleteMany({});

    const scopedB = storeScoped(storeBId);
    await scopedB.rlsTestFixture.deleteMany({});

    await rawPrisma.store.deleteMany({
      where: { slug: { in: ["test-store-a", "test-store-b"] } },
    });
    await rawPrisma.$disconnect();
  });

  it("store A can only read its own rows", async () => {
    const scoped = storeScoped(storeAId);
    const rows = await scoped.rlsTestFixture.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0].storeId).toBe(storeAId);
    expect(rows[0].value).toBe("Store A value");
  });

  it("store B can only read its own rows", async () => {
    const scoped = storeScoped(storeBId);
    const rows = await scoped.rlsTestFixture.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0].storeId).toBe(storeBId);
    expect(rows[0].value).toBe("Store B value");
  });

  it("store A cannot read store B rows", async () => {
    const scoped = storeScoped(storeAId);
    const rows = await scoped.rlsTestFixture.findMany();
    expect(rows.every((r) => r.storeId === storeAId)).toBe(true);
  });

  it("cross-store insert fails", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.rlsTestFixture.create({
        data: {
          storeId: storeBId,
          key: `rls_test_insert_${Date.now()}`,
          value: "should fail",
        },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("cross-store update fails", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.rlsTestFixture.updateMany({
        where: { storeId: storeBId },
        data: { value: "hacked" },
      }),
    ).resolves.toEqual({ count: 0 });
  });

  it("cross-store delete fails", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.rlsTestFixture.deleteMany({
        where: { storeId: storeBId },
      }),
    ).resolves.toEqual({ count: 0 });
  });

  it("no store_id set returns 0 rows", async () => {
    const result = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$queryRaw`SELECT * FROM store_content`,
    ]);
    expect(result[1]).toHaveLength(0);
  });

  it("no store_id set rejects writes", async () => {
    await expect(
      rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`INSERT INTO store_content (id, store_id, key, value, created_at, updated_at) VALUES ('rls_no_store', ${storeAId}, 'rls_no_store', 'x', NOW(), NOW())`,
      ]),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("owner role without storeScoped reads 0 rows from store_content", async () => {
    const rows = await rawPrisma.rlsTestFixture.findMany();
    expect(rows).toHaveLength(0);
  });

  it("owner role without storeScoped cannot insert into store_content", async () => {
    await expect(
      rawPrisma.rlsTestFixture.create({
        data: {
          storeId: storeAId,
          key: `rls_owner_bypass_${Date.now()}`,
          value: "should fail",
        },
      }),
    ).rejects.toThrow();
  });

  it("platform.store resolves stores via SET ROLE (app_runtime)", async () => {
    const store = await platform.store.findUnique({
      where: { slug: "test-store-a" },
    });
    expect(store).not.toBeNull();
    expect(store!.id).toBe(storeAId);
  });
});

const hasRuntime = hasDb && !!process.env.APP_RUNTIME_PASSWORD;

describe.skipIf(!hasRuntime)(
  "app_runtime security constraints",
  () => {
    let runtimePrisma: PrismaClient;

    beforeAll(async () => {
      const runtimeUrl = runtimeDatabaseUrl(process.env);
      const adapter = new PrismaPg(runtimeUrl);
      runtimePrisma = new PrismaClient({ adapter });
      await runtimePrisma.$connect();
    });

    afterAll(async () => {
      await runtimePrisma.$disconnect();
    });

    it("cannot DISABLE ROW LEVEL SECURITY (not the owner)", async () => {
      await expect(
        runtimePrisma.$executeRaw`ALTER TABLE store_content DISABLE ROW LEVEL SECURITY`,
      ).rejects.toThrow(/permission denied|must be owner/i);
    });

    it("cannot SET ROLE to the table owner", async () => {
      await expect(
        runtimePrisma.$executeRaw`SET ROLE app_owner`,
      ).rejects.toThrow(/permission denied|not a member/i);
    });

    it("without storeScoped returns 0 rows", async () => {
      const rows = await runtimePrisma.$transaction([
        runtimePrisma.$executeRaw`SET LOCAL ROLE app_user`,
        runtimePrisma.$queryRaw`SELECT * FROM store_content`,
      ]);
      expect(rows[1]).toHaveLength(0);
    });

    it("without storeScoped rejects inserts", async () => {
      await expect(
        runtimePrisma.$transaction([
          runtimePrisma.$executeRaw`SET LOCAL ROLE app_user`,
          runtimePrisma.$executeRaw`INSERT INTO store_content (id, store_id, key, value, created_at, updated_at) VALUES ('rt_test', 'fake', 'rt_key', 'x', NOW(), NOW())`,
        ]),
      ).rejects.toThrow(/42501|row-level security/i);
    });

    it("through storeScoped reads only own store rows", async () => {
      const ownerAdapter = new PrismaPg(process.env.DATABASE_URL!);
      const ownerPrisma = new PrismaClient({ adapter: ownerAdapter });
      await ownerPrisma.$connect();

      const store = await ownerPrisma.store.findFirst({
        where: { slug: "mama-ngozi" },
      });

      if (!store) {
        await ownerPrisma.$disconnect();
        return;
      }

      const scoped = storeScoped(store.id);
      const rows = await scoped.rlsTestFixture.findMany();
      expect(rows.every((r) => r.storeId === store.id)).toBe(true);

      await ownerPrisma.$disconnect();
    });
  },
);
