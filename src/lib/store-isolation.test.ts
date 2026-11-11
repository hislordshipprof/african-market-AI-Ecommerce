import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped, platform, platformAdmin, authPrisma } from "./db";
import { isRlsRejection } from "./listing/cross-store-write";
import { runtimeDatabaseUrl } from "./env";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Store isolation (RLS) via storeScoped", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    rawPrisma = testPrismaClient();
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

  it("app_user without store_id reads 0 rows from store_content", async () => {
    const result = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$queryRaw`SELECT * FROM store_content`,
    ]);
    expect(result[1]).toHaveLength(0);
  });

  it("app_user without store_id cannot insert into store_content", async () => {
    await expect(
      rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`INSERT INTO store_content (id, store_id, key, value, created_at, updated_at) VALUES ('rls_owner_bypass', ${storeAId}, 'rls_owner_bypass', 'x', NOW(), NOW())`,
      ]),
    ).rejects.toThrow(/42501|row-level security/i);
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
    rawPrisma = testPrismaClient();
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

  it("platform (app_user without admin flag) cannot insert into stores", async () => {
    await expect(
      platform.store.create({
        data: {
          slug: `rls-stores-insert-${Date.now()}`,
          name: "Should Fail",
          themePreset: "palm-and-shea",
        },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("platform (app_user without admin flag) update on stores affects 0 rows", async () => {
    const result = await platform.store.updateMany({
      where: { id: testStoreId },
      data: { name: "Hacked" },
    });
    expect(result.count).toBe(0);

    const store = await rawPrisma.store.findUnique({
      where: { id: testStoreId },
    });
    expect(store!.name).toBe("Admin RLS Test Store");
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

describe.skipIf(!hasDb)("StoreMembership and StoreInvite RLS", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let testUserId: string;

  beforeAll(async () => {
    rawPrisma = testPrismaClient();
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "rls-membership-a" },
      update: {},
      create: { slug: "rls-membership-a", name: "Membership Store A", themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "rls-membership-b" },
      update: {},
      create: { slug: "rls-membership-b", name: "Membership Store B", themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;

    const user = await rawPrisma.user.upsert({
      where: { email: "rls-test-member@example.com" },
      update: {},
      create: { id: "rls-test-member-id", email: "rls-test-member@example.com", name: "RLS Test Member", emailVerified: true },
    });
    testUserId = user.id;

    // FORCE ROW LEVEL SECURITY means even the owner role must satisfy a
    // policy. Use platform-admin context (SET LOCAL ROLE app_user + admin flag)
    // for setup/teardown on RLS-protected tables.
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeMembership.upsert({
        where: { storeId_userId: { storeId: storeAId, userId: testUserId } },
        update: {},
        create: { storeId: storeAId, userId: testUserId, role: "owner" },
      }),
    ]);

    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeMembership.upsert({
        where: { storeId_userId: { storeId: storeBId, userId: testUserId } },
        update: {},
        create: { storeId: storeBId, userId: testUserId, role: "staff" },
      }),
    ]);

    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeInvite.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeInvite.create({
        data: {
          storeId: storeAId,
          email: "invite-a@example.com",
          role: "staff",
          tokenHash: `rls_test_hash_a_${Date.now()}`,
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
          invitedById: testUserId,
        },
      }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeInvite.create({
        data: {
          storeId: storeBId,
          email: "invite-b@example.com",
          role: "staff",
          tokenHash: `rls_test_hash_b_${Date.now()}`,
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
          invitedById: testUserId,
        },
      }),
    ]);
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeInvite.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeMembership.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.user.deleteMany({ where: { email: "rls-test-member@example.com" } });
    await rawPrisma.store.deleteMany({ where: { slug: { in: ["rls-membership-a", "rls-membership-b"] } } });
    await rawPrisma.$disconnect();
  });

  it("storeScoped(A) sees only store A memberships", async () => {
    const scoped = storeScoped(storeAId);
    const rows = await scoped.storeMembership.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.storeId === storeAId)).toBe(true);
  });

  it("storeScoped(A) sees only store A invites", async () => {
    const scoped = storeScoped(storeAId);
    const rows = await scoped.storeInvite.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.storeId === storeAId)).toBe(true);
  });

  it("storeScoped(B) cannot see store A memberships", async () => {
    const scoped = storeScoped(storeBId);
    const rows = await scoped.storeMembership.findMany();
    expect(rows.every((r) => r.storeId === storeBId)).toBe(true);
  });

  it("cross-store membership insert fails", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.storeMembership.create({
        data: { storeId: storeBId, userId: testUserId, role: "staff" },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("cross-store invite insert fails", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.storeInvite.create({
        data: {
          storeId: storeBId,
          email: "cross-store@example.com",
          role: "staff",
          tokenHash: `cross_store_${Date.now()}`,
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
          invitedById: testUserId,
        },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("platformAdmin can read memberships across stores", async () => {
    const memberships = await platformAdmin.storeMembership.findMany({
      where: { storeId: { in: [storeAId, storeBId] } },
    });
    expect(memberships.some((m) => m.storeId === storeAId)).toBe(true);
    expect(memberships.some((m) => m.storeId === storeBId)).toBe(true);
  });

  it("platformAdmin can read invites across stores", async () => {
    const invites = await platformAdmin.storeInvite.findMany({
      where: { storeId: { in: [storeAId, storeBId] } },
    });
    const storeIds = new Set(invites.map((i) => i.storeId));
    expect(storeIds.has(storeAId)).toBe(true);
    expect(storeIds.has(storeBId)).toBe(true);
  });
});

describe.skipIf(!hasDb)("Stripe Connect column RLS isolation", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    rawPrisma = testPrismaClient();
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "rls-stripe-a" },
      update: { stripeAccountId: "acct_store_a", stripeOnboardingStatus: "complete" },
      create: {
        slug: "rls-stripe-a",
        name: "Stripe Store A",
        themePreset: "palm-and-shea",
        stripeAccountId: "acct_store_a",
        stripeOnboardingStatus: "complete",
      },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "rls-stripe-b" },
      update: { stripeAccountId: "acct_store_b", stripeOnboardingStatus: "pending" },
      create: {
        slug: "rls-stripe-b",
        name: "Stripe Store B",
        themePreset: "lagoon-and-coral",
        stripeAccountId: "acct_store_b",
        stripeOnboardingStatus: "pending",
      },
    });
    storeBId = storeB.id;
  });

  afterAll(async () => {
    await rawPrisma.rlsTestFixture.deleteMany({
      where: { storeId: { in: [storeAId, storeBId] } },
    });
    await rawPrisma.store.deleteMany({
      where: { slug: { in: ["rls-stripe-a", "rls-stripe-b"] } },
    });
    await rawPrisma.$disconnect();
  });

  it("platform (non-admin) cannot update store stripe fields", async () => {
    const result = await platform.store.updateMany({
      where: { id: storeAId },
      data: { stripeOnboardingStatus: "hacked" },
    });
    expect(result.count).toBe(0);

    const store = await rawPrisma.store.findUnique({ where: { id: storeAId } });
    expect(store!.stripeOnboardingStatus).toBe("complete");
  });

  it("app_user scoped to store B cannot update store A stripe fields", async () => {
    const result = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeBId}, true)`,
      rawPrisma.$executeRaw`UPDATE stores SET stripe_onboarding_status = 'hacked', store_delivery_enabled = true, store_delivery_fee_cents = 999, address_line1 = 'hacked', lat = 1, lng = 2 WHERE id = ${storeAId}`,
    ]);
    expect(result[2]).toBe(0);

    const store = await rawPrisma.store.findUnique({ where: { id: storeAId } });
    expect(store!.stripeOnboardingStatus).toBe("complete");
    expect(store!.storeDeliveryEnabled).toBe(false);
    expect(store!.storeDeliveryFeeCents).toBe(0);
    expect(store!.addressLine1).toBeNull();
  });

  it("platformAdmin can update stripe fields on any store", async () => {
    await platformAdmin.store.update({
      where: { id: storeBId },
      data: { stripeOnboardingStatus: "restricted" },
    });

    const store = await rawPrisma.store.findUnique({ where: { id: storeBId } });
    expect(store!.stripeOnboardingStatus).toBe("restricted");

    await rawPrisma.store.update({
      where: { id: storeBId },
      data: { stripeOnboardingStatus: "pending" },
    });
  });

  it("platform.store can read all stores including stripe fields", async () => {
    const store = await platform.store.findUnique({
      where: { slug: "rls-stripe-a" },
    });
    expect(store).not.toBeNull();
    expect(store!.stripeAccountId).toBe("acct_store_a");
    expect(store!.stripeOnboardingStatus).toBe("complete");
  });
});

const hasRuntime = hasDb && !!process.env.APP_RUNTIME_PASSWORD;

describe.skipIf(!hasRuntime)(
  "app_runtime security constraints",
  () => {
    let runtimePrisma: PrismaClient;

    beforeAll(async () => {
      const runtimeUrl = runtimeDatabaseUrl(process.env);
      runtimePrisma = testPrismaClient(runtimeUrl);
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
      ).rejects.toThrow(/permission denied|not a member|does not exist/i);
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
      const ownerPrisma = testPrismaClient();
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

describe.skipIf(!hasRuntime)(
  "FORCE RLS on store_memberships and store_invites via app_runtime",
  () => {
    let runtimePrisma: PrismaClient;
    let ownerPrisma: PrismaClient;
    let storeId: string;
    let userId: string;

    beforeAll(async () => {
      const runtimeUrl = runtimeDatabaseUrl(process.env);
      runtimePrisma = testPrismaClient(runtimeUrl);
      await runtimePrisma.$connect();

      ownerPrisma = testPrismaClient();
      await ownerPrisma.$connect();

      const store = await ownerPrisma.store.upsert({
        where: { slug: "rls-force-runtime" },
        update: {},
        create: {
          slug: "rls-force-runtime",
          name: "FORCE RLS Runtime Test",
          themePreset: "palm-and-shea",
        },
      });
      storeId = store.id;

      const user = await ownerPrisma.user.upsert({
        where: { email: "rls-force-runtime@example.com" },
        update: {},
        create: {
          id: "rls-force-runtime-user",
          email: "rls-force-runtime@example.com",
          name: "FORCE RLS User",
          emailVerified: true,
        },
      });
      userId = user.id;

      await ownerPrisma.$transaction([
        ownerPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        ownerPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        ownerPrisma.storeMembership.upsert({
          where: { storeId_userId: { storeId, userId } },
          update: {},
          create: { storeId, userId, role: "owner" },
        }),
      ]);

      await ownerPrisma.$transaction([
        ownerPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        ownerPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        ownerPrisma.storeInvite.create({
          data: {
            storeId,
            email: "force-rls-invite@example.com",
            role: "staff",
            tokenHash: `force_rls_${Date.now()}`,
            expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
            invitedById: userId,
          },
        }),
      ]);
    });

    afterAll(async () => {
      await ownerPrisma.$transaction([
        ownerPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        ownerPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        ownerPrisma.storeInvite.deleteMany({ where: { storeId } }),
      ]);
      await ownerPrisma.$transaction([
        ownerPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        ownerPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        ownerPrisma.storeMembership.deleteMany({ where: { storeId } }),
      ]);
      await ownerPrisma.user.deleteMany({ where: { email: "rls-force-runtime@example.com" } });
      await ownerPrisma.store.deleteMany({ where: { slug: "rls-force-runtime" } });
      await ownerPrisma.$disconnect();
      await runtimePrisma.$disconnect();
    });

    it("app_runtime without SET LOCAL ROLE reads 0 rows from store_memberships", async () => {
      const rows =
        await runtimePrisma.$queryRaw`SELECT * FROM store_memberships`;
      expect(rows).toHaveLength(0);
    });

    it("app_runtime without SET LOCAL ROLE reads 0 rows from store_invites", async () => {
      const rows =
        await runtimePrisma.$queryRaw`SELECT * FROM store_invites`;
      expect(rows).toHaveLength(0);
    });
  },
);

describe.skipIf(!hasDb)("notification logs: storeScoped(A) reads only A's rows and cannot write a row for B", () => {
  const slugA = "notify-rls-a";
  const slugB = "notify-rls-b";
  let storeAId = "";
  let storeBId = "";
  let orderBId = "";
  let raw: PrismaClient;

  beforeAll(async () => {
    raw = testPrismaClient();
    const storeA = await raw.store.create({
      data: { slug: slugA, name: "Notify RLS A", themePreset: "palm-and-shea" },
    });
    const storeB = await raw.store.create({
      data: { slug: slugB, name: "Notify RLS B", themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;
    storeBId = storeB.id;
    const customer = await storeScoped(storeBId).customer.create({
      data: { storeId: storeBId, name: "RLS Buyer", email: "notify-rls-b@example.com" },
    });
    const order = await storeScoped(storeBId).order.create({
      data: {
        storeId: storeBId,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 100,
        bufferCents: 0,
        totalCents: 100,
        totalAuthorizedCents: 100,
        number: 1,
      },
    });
    orderBId = order.id;
    await storeScoped(storeBId).notificationLog.create({
      data: { storeId: storeBId, orderId: order.id, event: "placed", channel: "email", status: "pending" },
    });
  });

  afterAll(async () => {
    for (const id of [storeAId, storeBId]) {
      if (!id) continue;
      const scoped = storeScoped(id);
      await scoped.notificationLog.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeAId, storeBId].filter(Boolean) } } });
    await raw.$disconnect();
  });

  it("notification logs: storeScoped(A) reads only A's rows and cannot write a row for B", async () => {
    expect(await storeScoped(storeAId).notificationLog.findMany()).toEqual([]);
    await expect(
      storeScoped(storeAId).notificationLog.create({
        data: { storeId: storeBId, orderId: orderBId, event: "placed", channel: "sms", status: "pending" },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    expect(await storeScoped(storeBId).notificationLog.count({ where: { orderId: orderBId } })).toBe(1);
  });
});

describe.skipIf(!hasDb)("delivery events and issue reports: storeScoped(B) cannot read or write store A's rows", () => {
  let storeAId = "";
  let storeBId = "";
  let orderAId = "";
  let raw: PrismaClient;

  beforeAll(async () => {
    raw = testPrismaClient();
    const stamp = Date.now().toString(36);
    const storeA = await raw.store.create({
      data: { slug: `delivery-rls-a-${stamp}`, name: "Delivery RLS A", themePreset: "palm-and-shea" },
    });
    const storeB = await raw.store.create({
      data: { slug: `delivery-rls-b-${stamp}`, name: "Delivery RLS B", themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;
    storeBId = storeB.id;
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "RLS Buyer", email: "delivery-rls-a@example.com" },
    });
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        customerId: customer.id,
        status: "OUT_FOR_DELIVERY",
        fulfillment: "store-delivery",
        subtotalCents: 100,
        bufferCents: 0,
        totalCents: 100,
        totalAuthorizedCents: 100,
        number: 1,
      },
    });
    orderAId = order.id;
    await storeScoped(storeAId).deliveryEvent.create({
      data: { storeId: storeAId, orderId: order.id, type: "out_for_delivery", payload: {} },
    });
    await storeScoped(storeAId).issueReport.create({
      data: { storeId: storeAId, orderId: order.id, type: "damaged", lines: [], amountCents: 100, state: "in_review" },
    });
  });

  afterAll(async () => {
    for (const id of [storeAId, storeBId]) {
      if (!id) continue;
      const scoped = storeScoped(id);
      await scoped.deliveryEvent.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeAId, storeBId].filter(Boolean) } } });
    await raw.$disconnect();
  });

  it("delivery events: storeScoped(B) reads none of A's rows, cannot insert one for A, and deletes nothing", async () => {
    expect(await storeScoped(storeBId).deliveryEvent.findMany()).toEqual([]);
    await expect(
      storeScoped(storeBId).deliveryEvent.create({
        data: { storeId: storeAId, orderId: orderAId, type: "delivered", payload: {} },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    expect((await storeScoped(storeBId).deliveryEvent.deleteMany({ where: { orderId: orderAId } })).count).toBe(0);
    expect(await storeScoped(storeAId).deliveryEvent.count({ where: { orderId: orderAId } })).toBe(1);
  });

  it("issue reports: storeScoped(B) reads none of A's, cannot insert or update one for A", async () => {
    expect(await storeScoped(storeBId).issueReport.findMany()).toEqual([]);
    await expect(
      storeScoped(storeBId).issueReport.create({
        data: { storeId: storeAId, orderId: orderAId, type: "wrong", lines: [], amountCents: 1, state: "in_review" },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    expect((await storeScoped(storeBId).issueReport.updateMany({ where: { orderId: orderAId }, data: { state: "approved" } })).count).toBe(0);
    const own = await storeScoped(storeAId).issueReport.findMany({ where: { orderId: orderAId } });
    expect(own.map((row) => row.state)).toEqual(["in_review"]);
  });
});

describe.skipIf(!hasDb)("support threads and messages: storeScoped(B) cannot read or write store A's rows", () => {
  let storeAId = "";
  let storeBId = "";
  let orderAId = "";
  let threadAId = "";
  let raw: PrismaClient;

  beforeAll(async () => {
    raw = testPrismaClient();
    const stamp = Date.now().toString(36);
    storeAId = (await raw.store.create({
      data: { slug: `support-rls-a-${stamp}`, name: "Support RLS A", themePreset: "palm-and-shea" },
    })).id;
    storeBId = (await raw.store.create({
      data: { slug: `support-rls-b-${stamp}`, name: "Support RLS B", themePreset: "palm-and-shea" },
    })).id;
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "RLS Buyer", email: "support-rls-a@example.com" },
    });
    orderAId = (await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        customerId: customer.id,
        status: "ACCEPTED",
        fulfillment: "pickup",
        subtotalCents: 100,
        bufferCents: 0,
        totalCents: 100,
        totalAuthorizedCents: 100,
        number: 1,
      },
    })).id;
    threadAId = (await storeScoped(storeAId).supportThread.create({
      data: { storeId: storeAId, orderId: orderAId, lastCustomerAt: new Date() },
    })).id;
    await storeScoped(storeAId).supportMessage.create({
      data: { storeId: storeAId, threadId: threadAId, sender: "customer", body: "Where is my order?" },
    });
  });

  afterAll(async () => {
    for (const id of [storeAId, storeBId]) {
      if (!id) continue;
      const scoped = storeScoped(id);
      await scoped.supportMessage.deleteMany({});
      await scoped.supportThread.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeAId, storeBId].filter(Boolean) } } });
    await raw.$disconnect();
  });

  it("support threads: storeScoped(B) reads none of A's threads, cannot insert one for A, and updates nothing", async () => {
    expect(await storeScoped(storeBId).supportThread.findMany()).toEqual([]);
    await expect(
      storeScoped(storeBId).supportThread.create({ data: { storeId: storeAId, orderId: orderAId } }),
    ).rejects.toSatisfy(isRlsRejection);
    expect((await storeScoped(storeBId).supportThread.updateMany({
      where: { id: threadAId },
      data: { state: "resolved" },
    })).count).toBe(0);
    expect((await storeScoped(storeAId).supportThread.findUnique({ where: { id: threadAId } }))?.state).toBe("open");
  });

  it("support messages: storeScoped(B) reads none of A's messages and cannot reply on A's thread", async () => {
    expect(await storeScoped(storeBId).supportMessage.findMany()).toEqual([]);
    await expect(
      storeScoped(storeBId).supportMessage.create({
        data: { storeId: storeAId, threadId: threadAId, sender: "store", body: "hello" },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    expect(await storeScoped(storeAId).supportMessage.count({ where: { threadId: threadAId } })).toBe(1);
  });
});

describe.skipIf(!hasDb)("owner reports and their items: storeScoped(B) cannot read or write store A's rows", () => {
  let storeAId = "";
  let storeBId = "";
  let reportAId = "";
  let itemAId = "";
  let listingAId = "";
  let actorId = "";
  let raw: PrismaClient;

  beforeAll(async () => {
    raw = testPrismaClient();
    const stamp = Date.now().toString(36);
    storeAId = (await raw.store.create({
      data: { slug: `report-rls-a-${stamp}`, name: "Report RLS A", themePreset: "palm-and-shea" },
    })).id;
    storeBId = (await raw.store.create({
      data: { slug: `report-rls-b-${stamp}`, name: "Report RLS B", themePreset: "palm-and-shea" },
    })).id;
    actorId = `report-rls-${stamp}`;
    await raw.user.create({ data: { id: actorId, email: `${actorId}@example.com`, name: "Reporter" } });
    listingAId = (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: "Gari", price: 500, stockMode: "counted", qty: 3 },
    })).id;
    reportAId = (await storeScoped(storeAId).ownerReport.create({
      data: { storeId: storeAId, actorId, type: "voice", rawTranscript: "20 gari", aiExtraction: { items: [] } },
    })).id;
    itemAId = (await storeScoped(storeAId).ownerReportItem.create({
      data: {
        storeId: storeAId, reportId: reportAId, extractedName: "gari", extractedQty: 20,
        listingId: listingAId, matchConfidence: 1, kind: "restock", proposedDelta: 20, status: "pending",
      },
    })).id;
  });

  afterAll(async () => {
    for (const id of [storeAId, storeBId]) {
      if (!id) continue;
      await storeScoped(id).ownerReport.deleteMany({});
      await storeScoped(id).listing.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeAId, storeBId].filter(Boolean) } } });
    await raw.user.deleteMany({ where: { id: actorId } });
    await raw.$disconnect();
  });

  it("owner reports: storeScoped(B) reads none of A's, cannot insert one for A, and updates nothing", async () => {
    expect(await storeScoped(storeBId).ownerReport.findUnique({ where: { id: reportAId } })).toBeNull();
    await expect(
      storeScoped(storeBId).ownerReport.create({
        data: { storeId: storeAId, actorId, type: "voice", rawTranscript: "x", aiExtraction: {} },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    expect((await storeScoped(storeBId).ownerReport.updateMany({
      where: { id: reportAId },
      data: { status: "rejected", decidedById: actorId, decidedAt: new Date() },
    })).count).toBe(0);
    expect((await storeScoped(storeAId).ownerReport.findUnique({ where: { id: reportAId } }))?.status).toBe("pending");
  });

  it("owner report items: storeScoped(B) reads none of A's, cannot add one to A's report, and updates nothing", async () => {
    expect(await storeScoped(storeBId).ownerReportItem.findMany()).toEqual([]);
    for (const storeId of [storeAId, storeBId]) {
      await expect(
        storeScoped(storeBId).ownerReportItem.create({
          data: { storeId, reportId: reportAId, extractedName: "rice", extractedQty: 1, status: "unmatched" },
        }),
      ).rejects.toSatisfy(isRlsRejection);
    }
    expect((await storeScoped(storeBId).ownerReportItem.updateMany({
      where: { id: itemAId },
      data: { status: "confirmed" },
    })).count).toBe(0);
    expect((await storeScoped(storeAId).ownerReportItem.findUnique({ where: { id: itemAId } }))?.status).toBe("pending");
  });
});

describe.skipIf(!hasDb)("orders, order lines and audit logs: storeScoped(B) cannot read or write store A's rows", () => {
  let storeAId = "";
  let storeBId = "";
  let customerAId = "";
  let orderAId = "";
  let lineAId = "";
  let variantAId = "";
  let auditAId = "";
  let actorId = "";
  let raw: PrismaClient;

  beforeAll(async () => {
    raw = testPrismaClient();
    const stamp = Date.now().toString(36);
    storeAId = (await raw.store.create({
      data: { slug: `order-rls-a-${stamp}`, name: "Order RLS A", themePreset: "palm-and-shea" },
    })).id;
    storeBId = (await raw.store.create({
      data: { slug: `order-rls-b-${stamp}`, name: "Order RLS B", themePreset: "palm-and-shea" },
    })).id;
    actorId = `order-rls-${stamp}`;
    await raw.user.create({ data: { id: actorId, email: `${actorId}@example.com`, name: "Owner" } });
    const scopedA = storeScoped(storeAId);
    const listing = await scopedA.listing.create({
      data: { storeId: storeAId, customName: "Gari", price: 500, stockMode: "unlimited" },
    });
    variantAId = (await scopedA.listingVariant.create({
      data: { listingId: listing.id, label: "1kg", price: 500, weightG: 1000 },
    })).id;
    customerAId = (await scopedA.customer.create({ data: { storeId: storeAId, name: "RLS Buyer" } })).id;
    orderAId = (await scopedA.order.create({
      data: {
        storeId: storeAId, customerId: customerAId, status: "AUTHORIZED", fulfillment: "pickup",
        subtotalCents: 500, bufferCents: 0, totalCents: 500, totalAuthorizedCents: 500, number: 1,
      },
    })).id;
    lineAId = (await scopedA.orderLine.create({
      data: { storeId: storeAId, orderId: orderAId, listingVariantId: variantAId, qtyOrdered: 1, unitPriceCents: 500 },
    })).id;
    auditAId = (await scopedA.auditLog.create({
      data: {
        storeId: storeAId, actorId, actorEmail: `${actorId}@example.com`,
        action: "order_placed", entityType: "order", entityId: orderAId,
      },
    })).id;
  });

  afterAll(async () => {
    const storeIds = [storeAId, storeBId].filter(Boolean);
    await raw.$transaction([
      raw.$executeRaw`SET LOCAL ROLE app_user`,
      raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      raw.auditLog.deleteMany({ where: { storeId: { in: storeIds } } }),
    ]);
    for (const id of storeIds) {
      await storeScoped(id).order.deleteMany({});
      await storeScoped(id).customer.deleteMany({});
      await storeScoped(id).listing.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: storeIds } } });
    await raw.user.deleteMany({ where: { id: actorId } });
    await raw.$disconnect();
  });

  it("orders: storeScoped(B) reads null, update throws P2025, updateMany and insert change nothing of A's", async () => {
    const scopedB = storeScoped(storeBId);
    expect(await scopedB.order.findUnique({ where: { id: orderAId } })).toBeNull();
    await expect(scopedB.order.update({ where: { id: orderAId }, data: { status: "CANCELLED" } }))
      .rejects.toMatchObject({ code: "P2025" });
    expect((await scopedB.order.updateMany({ where: { id: orderAId }, data: { status: "CANCELLED" } })).count).toBe(0);
    await expect(scopedB.order.create({
      data: {
        storeId: storeAId, customerId: customerAId, status: "AUTHORIZED", fulfillment: "pickup",
        subtotalCents: 1, bufferCents: 0, totalCents: 1, totalAuthorizedCents: 1, number: 2,
      },
    })).rejects.toSatisfy(isRlsRejection);
    const own = await storeScoped(storeAId).order.findMany();
    expect(own.map((order) => [order.id, order.status])).toEqual([[orderAId, "AUTHORIZED"]]);
  });

  it("order lines: storeScoped(B) reads null, update throws P2025, updateMany and insert change nothing of A's", async () => {
    const scopedB = storeScoped(storeBId);
    expect(await scopedB.orderLine.findUnique({ where: { id: lineAId } })).toBeNull();
    await expect(scopedB.orderLine.update({ where: { id: lineAId }, data: { qtyPicked: 1 } }))
      .rejects.toMatchObject({ code: "P2025" });
    expect((await scopedB.orderLine.updateMany({ where: { orderId: orderAId }, data: { qtyPicked: 1 } })).count).toBe(0);
    await expect(scopedB.orderLine.create({
      data: { storeId: storeAId, orderId: orderAId, listingVariantId: variantAId, qtyOrdered: 9, unitPriceCents: 1 },
    })).rejects.toSatisfy(isRlsRejection);
    const own = await storeScoped(storeAId).orderLine.findMany({ where: { orderId: orderAId } });
    expect(own.map((line) => [line.id, line.qtyOrdered, line.qtyPicked])).toEqual([[lineAId, 1, 0]]);
  });

  it("audit logs: storeScoped(B) reads null and cannot insert for A; append-only, so even A updates and deletes 0 rows", async () => {
    const scopedA = storeScoped(storeAId);
    const scopedB = storeScoped(storeBId);
    expect(await scopedB.auditLog.findUnique({ where: { id: auditAId } })).toBeNull();
    await expect(scopedB.auditLog.create({
      data: {
        storeId: storeAId, actorId, actorEmail: `${actorId}@example.com`,
        action: "forged", entityType: "order", entityId: orderAId,
      },
    })).rejects.toSatisfy(isRlsRejection);
    for (const scoped of [scopedA, scopedB]) {
      expect((await scoped.auditLog.updateMany({ where: { id: auditAId }, data: { action: "rewritten" } })).count).toBe(0);
      expect((await scoped.auditLog.deleteMany({ where: { id: auditAId } })).count).toBe(0);
    }
    const own = await scopedA.auditLog.findMany({ where: { entityId: orderAId } });
    expect(own.map((row) => [row.id, row.action])).toEqual([[auditAId, "order_placed"]]);
  });
});
