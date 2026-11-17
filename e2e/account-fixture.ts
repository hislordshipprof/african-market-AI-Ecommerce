import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
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
