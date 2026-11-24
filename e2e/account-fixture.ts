import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword, symmetricEncrypt } from "better-auth/crypto";
import { resolveDirectUrl } from "../src/lib/env";

/**
 * An unverified shopper account with a name and a password, as the old public sign-up made it.
 * /sign-up/email is closed (#710), so the rows are written straight to the lane database.
 */
export async function insertShopperAccount(input: { email: string; name: string; password: string }): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    const id = randomUUID();
    await prisma.user.create({ data: { id, email: input.email.toLowerCase(), name: input.name } });
    await prisma.account.create({
      data: { id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword(input.password) },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * A mama-ngozi owner with 2FA enrolled under `authSecret`, for a spawned server that cannot run on the seed's secret.
 * Returns the user id; `deleteUser` removes it with its account, 2FA and membership.
 */
export async function insertStoreOwner(input: { email: string; password: string; authSecret: string; totpSecret: string }): Promise<string> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    const id = randomUUID();
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } });
    await prisma.user.create({ data: { id, email: input.email, name: "Alias Owner", emailVerified: true, twoFactorEnabled: true } });
    await prisma.account.create({
      data: { id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword(input.password) },
    });
    await prisma.twoFactor.create({
      data: {
        id: randomUUID(),
        userId: id,
        verified: true,
        secret: await symmetricEncrypt({ key: input.authSecret, data: `base32:${input.totpSecret}` }),
        backupCodes: await symmetricEncrypt({ key: input.authSecret, data: "[]" }),
      },
    });
    await prisma.storeMembership.create({ data: { storeId: store.id, userId: id, role: "owner", newOrderEmail: false } });
    return id;
  } finally {
    await prisma.$disconnect();
  }
}

/** The newest password reset token for `userId`, as the emailed link carries it. */
export async function latestResetToken(userId: string): Promise<string> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    const row = await prisma.verification.findFirstOrThrow({
      where: { value: userId, identifier: { startsWith: "reset-password:" } },
      orderBy: { createdAt: "desc" },
    });
    return row.identifier.slice("reset-password:".length);
  } finally {
    await prisma.$disconnect();
  }
}

export async function deleteUser(userId: string): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    await prisma.storeMembership.deleteMany({ where: { userId } });
    await prisma.verification.deleteMany({ where: { value: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  } finally {
    await prisma.$disconnect();
  }
}
