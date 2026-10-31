import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { resolveDirectUrl } from "../src/lib/env";
import { assertNotProduction } from "../src/lib/seed-guard";
import { seedDemoCatalog } from "./seed-demo-catalog";

const adapter = new PrismaPg(resolveDirectUrl());
const prisma = new PrismaClient({ adapter });

async function seedDemoStores() {
  const storeA = await prisma.store.upsert({
    where: { slug: "mama-ngozi" },
    update: {},
    create: {
      slug: "mama-ngozi",
      name: "Mama Ngozi African Market",
      brandColor: "#1F5A43",
      themePreset: "palm-and-shea",
      logoUrl: "/logos/mama-ngozi-logo.svg",
      status: "active",
      prepTimeMinutes: 30,
      deliveryRadiusMi: 8,
      minimumOrderCents: 3500,
      pickupEnabled: true,
      autoRefundLimitCents: 2500,
    },
  });

  const storeB = await prisma.store.upsert({
    where: { slug: "tante-marie" },
    update: {},
    create: {
      slug: "tante-marie",
      name: "Tante Marie Caribbean Grocer",
      brandColor: "#0F4A57",
      themePreset: "lagoon-and-coral",
      logoUrl: "/logos/tante-marie-logo.svg",
      status: "active",
      prepTimeMinutes: 25,
      deliveryRadiusMi: 6,
      minimumOrderCents: 3000,
      pickupEnabled: false,
      autoRefundLimitCents: 2000,
    },
  });

  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL ROLE app_user`,
    prisma.$executeRaw`SELECT set_config('app.store_id', ${storeA.id}, true)`,
    prisma.rlsTestFixture.upsert({
      where: { storeId_key: { storeId: storeA.id, key: "hero_text" } },
      update: {},
      create: {
        storeId: storeA.id,
        key: "hero_text",
        value: "Fresh African groceries delivered to your door",
      },
    }),
  ]);

  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL ROLE app_user`,
    prisma.$executeRaw`SELECT set_config('app.store_id', ${storeB.id}, true)`,
    prisma.rlsTestFixture.upsert({
      where: { storeId_key: { storeId: storeB.id, key: "hero_text" } },
      update: {},
      create: {
        storeId: storeB.id,
        key: "hero_text",
        value: "Caribbean flavors, delivered fresh",
      },
    }),
  ]);

  console.log("Seeded 2 demo stores: mama-ngozi, tante-marie");
}

async function seedTestAdmin() {
  assertNotProduction(process.env);

  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error("SEED_ADMIN_PASSWORD is required when SEED_TEST_ADMIN=1");
  }

  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!authSecret) {
    throw new Error("BETTER_AUTH_SECRET is required when SEED_TEST_ADMIN=1");
  }

  const totpSecret = process.env.SEED_ADMIN_TOTP_SECRET;
  if (!totpSecret) {
    throw new Error("SEED_ADMIN_TOTP_SECRET is required when SEED_TEST_ADMIN=1");
  }

  const adminId = "seed-platform-admin";
  const adminEmail = "admin@platform.test";
  const hashedPassword = await hashPassword(adminPassword);

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: { twoFactorEnabled: true },
    create: {
      id: adminId,
      name: "Platform Admin",
      email: adminEmail,
      emailVerified: true,
      role: "platform_admin",
      twoFactorEnabled: true,
      updatedAt: new Date(),
    },
  });

  const existingAccount = await prisma.account.findFirst({
    where: { userId: adminId, providerId: "credential" },
  });
  if (existingAccount) {
    await prisma.account.update({
      where: { id: existingAccount.id },
      data: { password: hashedPassword, updatedAt: new Date() },
    });
  } else {
    await prisma.account.create({
      data: {
        id: "seed-admin-account",
        accountId: adminId,
        providerId: "credential",
        userId: adminId,
        password: hashedPassword,
        updatedAt: new Date(),
      },
    });
  }

  const encryptedSecret = await symmetricEncrypt({
    key: authSecret,
    data: `base32:${totpSecret}`,
  });
  const encryptedBackupCodes = await symmetricEncrypt({
    key: authSecret,
    data: JSON.stringify(["BACKUP1234", "BACKUP5678"]),
  });

  const existingTwoFactor = await prisma.twoFactor.findFirst({
    where: { userId: adminId },
  });
  if (existingTwoFactor) {
    await prisma.twoFactor.update({
      where: { id: existingTwoFactor.id },
      data: { secret: encryptedSecret, backupCodes: encryptedBackupCodes },
    });
  } else {
    await prisma.twoFactor.create({
      data: {
        id: "seed-admin-totp",
        secret: encryptedSecret,
        backupCodes: encryptedBackupCodes,
        userId: adminId,
        verified: true,
      },
    });
  }

  console.log("Seeded test admin: admin@platform.test (2FA enrolled)");

  // Unenrolled admin for 2FA enrollment e2e test
  const unenrolledId = "seed-unenrolled-admin";
  const unenrolledEmail = "unenrolled-admin@platform.test";

  await prisma.$transaction(async (tx) => {
    await tx.twoFactor.deleteMany({ where: { userId: unenrolledId } });

    await tx.user.upsert({
      where: { email: unenrolledEmail },
      update: { twoFactorEnabled: false, updatedAt: new Date() },
      create: {
        id: unenrolledId,
        name: "Unenrolled Admin",
        email: unenrolledEmail,
        emailVerified: true,
        role: "platform_admin",
        twoFactorEnabled: false,
        updatedAt: new Date(),
      },
    });

    const existingUnenrolledAccount = await tx.account.findFirst({
      where: { userId: unenrolledId, providerId: "credential" },
    });
    if (existingUnenrolledAccount) {
      await tx.account.update({
        where: { id: existingUnenrolledAccount.id },
        data: { password: hashedPassword, updatedAt: new Date() },
      });
    } else {
      await tx.account.create({
        data: {
          id: "seed-unenrolled-account",
          accountId: unenrolledId,
          providerId: "credential",
          userId: unenrolledId,
          password: hashedPassword,
          updatedAt: new Date(),
        },
      });
    }
  });

  console.log("Seeded unenrolled admin: unenrolled-admin@platform.test");
}

async function seedStoreOwner() {
  assertNotProduction(process.env);

  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error("SEED_ADMIN_PASSWORD is required when SEED_TEST_ADMIN=1");
  }
  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!authSecret) {
    throw new Error("BETTER_AUTH_SECRET is required when SEED_TEST_ADMIN=1");
  }
  const totpSecret = process.env.SEED_ADMIN_TOTP_SECRET;
  if (!totpSecret) {
    throw new Error("SEED_ADMIN_TOTP_SECRET is required when SEED_TEST_ADMIN=1");
  }

  const ownerId = "seed-store-owner";
  const ownerEmail = "owner@mama-ngozi.test";
  const hashedPassword = await hashPassword(adminPassword);

  await prisma.user.upsert({
    where: { email: ownerEmail },
    update: { twoFactorEnabled: true },
    create: {
      id: ownerId,
      name: "Mama Ngozi Owner",
      email: ownerEmail,
      emailVerified: true,
      role: "user",
      twoFactorEnabled: true,
      updatedAt: new Date(),
    },
  });

  const existingAccount = await prisma.account.findFirst({
    where: { userId: ownerId, providerId: "credential" },
  });
  if (existingAccount) {
    await prisma.account.update({
      where: { id: existingAccount.id },
      data: { password: hashedPassword, updatedAt: new Date() },
    });
  } else {
    await prisma.account.create({
      data: {
        id: "seed-store-owner-account",
        accountId: ownerId,
        providerId: "credential",
        userId: ownerId,
        password: hashedPassword,
        updatedAt: new Date(),
      },
    });
  }

  const encryptedSecret = await symmetricEncrypt({
    key: authSecret,
    data: `base32:${totpSecret}`,
  });
  const encryptedBackupCodes = await symmetricEncrypt({
    key: authSecret,
    data: JSON.stringify(["OWNERBACKUP1", "OWNERBACKUP2"]),
  });

  const existingTwoFactor = await prisma.twoFactor.findFirst({
    where: { userId: ownerId },
  });
  if (existingTwoFactor) {
    await prisma.twoFactor.update({
      where: { id: existingTwoFactor.id },
      data: { secret: encryptedSecret, backupCodes: encryptedBackupCodes },
    });
  } else {
    await prisma.twoFactor.create({
      data: {
        id: "seed-store-owner-totp",
        secret: encryptedSecret,
        backupCodes: encryptedBackupCodes,
        userId: ownerId,
        verified: true,
      },
    });
  }

  const mamaNgozi = await prisma.store.findUnique({ where: { slug: "mama-ngozi" } });
  if (!mamaNgozi) throw new Error("mama-ngozi store not found; run seedDemoStores first");

  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL ROLE app_user`,
    prisma.$executeRaw`SELECT set_config('app.store_id', ${mamaNgozi.id}, true)`,
    prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
    prisma.storeMembership.upsert({
      where: { storeId_userId: { storeId: mamaNgozi.id, userId: ownerId } },
      update: { role: "owner" },
      create: { storeId: mamaNgozi.id, userId: ownerId, role: "owner" },
    }),
  ]);

  console.log("Seeded store owner: owner@mama-ngozi.test (2FA enrolled, mama-ngozi owner)");
}

async function main() {
  await seedDemoStores();
  await seedDemoCatalog(prisma);

  if (process.env.SEED_TEST_ADMIN === "1") {
    await seedTestAdmin();
    await seedStoreOwner();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
