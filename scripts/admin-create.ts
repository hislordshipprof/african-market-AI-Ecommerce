#!/usr/bin/env tsx
/**
 * One-off script to create a platform admin account.
 * Usage: pnpm admin:create <email>
 *
 * Generates a random password and prints it once. For human use on
 * preview/staging deployments where the seed does not create an admin.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { randomBytes } from "node:crypto";
import { resolveDirectUrl } from "../src/lib/env";
import { normalizeEmail } from "../src/lib/email";

const rawEmail = process.argv[2];
if (!rawEmail || !rawEmail.includes("@")) {
  console.error("Usage: pnpm admin:create <email>");
  process.exit(1);
}
const email = normalizeEmail(rawEmail);

const adapter = new PrismaPg(resolveDirectUrl());
const prisma = new PrismaClient({ adapter });

async function main() {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.error(`User ${email} already exists (id=${existing.id}).`);
    process.exit(1);
  }

  const password = randomBytes(24).toString("base64url");
  const hashed = await hashPassword(password);
  const id = `admin-${randomBytes(8).toString("hex")}`;

  await prisma.user.create({
    data: {
      id,
      name: "Platform Admin",
      email,
      emailVerified: true,
      role: "platform_admin",
      twoFactorEnabled: false,
      updatedAt: new Date(),
    },
  });

  await prisma.account.create({
    data: {
      id: `${id}-account`,
      accountId: id,
      providerId: "credential",
      userId: id,
      password: hashed,
      updatedAt: new Date(),
    },
  });

  console.log(`Created platform admin: ${email}`);
  console.log(`Password: ${password}`);
  console.log("Sign in and complete 2FA enrollment at /admin/sign-in");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
