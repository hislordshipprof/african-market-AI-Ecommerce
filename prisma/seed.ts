import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { resolveDirectUrl } from "../src/lib/env";

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

async function main() {
  await seedDemoStores();

  if (process.env.SEED_TEST_ADMIN === "1") {
    await seedTestAdmin();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
