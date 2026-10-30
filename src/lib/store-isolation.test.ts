import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped, platform, platformAdmin, authPrisma } from "./db";
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

describe.skipIf(!hasDb)("Platform admin RLS (DB-backed)", () => {
  let rawPrisma: PrismaClient;
  let testStoreId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const store = await rawPrisma.store.upsert({
      where: { slug: "test-admin-rls" },
      update: {},
      create: {
        slug: "test-admin-rls",
        name: "Admin RLS Test Store",
        themePreset: "palm-and-shea",
      },
    });
    testStoreId = store.id;
  });

  afterAll(async () => {
    await rawPrisma.store.deleteMany({
      where: { slug: "test-admin-rls" },
    });
    await rawPrisma.$disconnect();
  });

  it("platformAdmin can create a store", async () => {
    const store = await platformAdmin.store.create({
      data: {
        slug: "test-admin-create",
        name: "Admin Created Store",
        themePreset: "palm-and-shea",
      },
    });
    expect(store.slug).toBe("test-admin-create");

    await rawPrisma.store.delete({ where: { id: store.id } });
  });

  it("platformAdmin can update a store", async () => {
    const updated = await platformAdmin.store.update({
      where: { id: testStoreId },
      data: { name: "Admin RLS Test Store Updated" },
    });
    expect(updated.name).toBe("Admin RLS Test Store Updated");

    await rawPrisma.store.update({
      where: { id: testStoreId },
      data: { name: "Admin RLS Test Store" },
    });
  });

  it("app_runtime without admin flag cannot write stores of other stores", async () => {
    const scoped = storeScoped("nonexistent-store-id");
    await expect(
      scoped.rlsTestFixture.create({
        data: {
          storeId: testStoreId,
          key: `admin_rls_test_${Date.now()}`,
          value: "should fail",
        },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("platform admin flag does not persist after transaction", async () => {
    // Prove SET LOCAL scopes the flag to the transaction. Uses authPrisma
    // (the same pool platformAdmin wraps) so a leaked SET (without LOCAL)
    // would be visible on the reused connection. Mutation proof: changing
    // set_config's third arg from true to false in db.ts makes this fail.
    await platformAdmin.store.findUnique({ where: { id: testStoreId } });

    const result = await authPrisma.$transaction([
      authPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      authPrisma.$queryRaw`SELECT current_setting('app.is_platform_admin', true) as admin_flag`,
    ]);
    const rows = result[1] as Array<{ admin_flag: string | null }>;
    expect(rows[0].admin_flag === "" || rows[0].admin_flag === null).toBe(true);
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
