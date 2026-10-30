import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { resolveDirectUrl } from "../src/lib/env";

const adapter = new PrismaPg(resolveDirectUrl());
const prisma = new PrismaClient({ adapter });

const SEED_TOTP_SECRET = "seed-totp-secret-for-e2e-tests!";

async function main() {
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

  const adminId = "seed-platform-admin";
  const adminEmail = "admin@platform.test";
  const adminPassword = await hashPassword("Test1234!");

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
  if (!existingAccount) {
    await prisma.account.create({
      data: {
        id: "seed-admin-account",
        accountId: adminId,
        providerId: "credential",
        userId: adminId,
        password: adminPassword,
        updatedAt: new Date(),
      },
    });
  }

  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!authSecret) {
    console.warn("BETTER_AUTH_SECRET not set; skipping 2FA seed enrollment");
  } else {
    const encryptedSecret = await symmetricEncrypt({
      key: authSecret,
      data: SEED_TOTP_SECRET,
    });
    const encryptedBackupCodes = await symmetricEncrypt({
      key: authSecret,
      data: JSON.stringify(["BACKUP1234", "BACKUP5678"]),
    });

    const existingTwoFactor = await prisma.twoFactor.findFirst({
      where: { userId: adminId },
    });
    if (!existingTwoFactor) {
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
  }

  console.log("Seeded 2 stores: mama-ngozi, tante-marie");
  console.log("Seeded platform admin: admin@platform.test / Test1234! (2FA enrolled)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
