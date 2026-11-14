import { afterAll, describe, expect, it } from "vitest";
import { testPrismaClient } from "@/lib/test-prisma";
import { resolveDirectUrl } from "./env";

const hasDb = !!process.env.DATABASE_URL;

// #51 item 4: the seed upserts a user by email, so the account and 2FA rows
// must hang off the user it found, not the id it would have created.
describe.skipIf(!hasDb)("seedUserWith2FA", () => {
  const run = Date.now();
  const email = `seed-2fa-${run}@example.com`;
  const existingId = `seed-2fa-existing-${run}`;
  const prisma = testPrismaClient(resolveDirectUrl());

  const opts = {
    id: `seed-2fa-new-${run}`,
    name: "Seed 2FA Test",
    email,
    role: "user",
    password: "seed-2fa-password",
    authSecret: "seed-2fa-auth-secret-at-least-32-chars",
    totpSecret: "JBSWY3DPEHPK3PXP",
    backupCodes: ["SEEDTEST1"],
    accountId: `seed-2fa-account-${run}`,
    twoFactorId: `seed-2fa-totp-${run}`,
  };

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it("attaches the account and 2FA to a user that already exists under another id, and reruns cleanly", async () => {
    await prisma.user.create({
      data: { id: existingId, name: "Pre-existing", email, emailVerified: true, updatedAt: new Date() },
    });
    const { seedUserWith2FA } = await import("../../prisma/seed");

    const user = await seedUserWith2FA(opts);
    await seedUserWith2FA(opts);

    expect(user.id).toBe(existingId);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect(
      await prisma.account.findMany({ where: { userId: existingId }, select: { providerId: true } }),
    ).toEqual([{ providerId: "credential" }]);
    expect(await prisma.twoFactor.count({ where: { userId: existingId } })).toBe(1);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: existingId } })).toMatchObject({
      twoFactorEnabled: true,
    });
  });
});
