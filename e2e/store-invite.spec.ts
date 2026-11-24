import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const SHOTS = process.env.PROOF_DIR ?? "screenshots";

function db() {
  return new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
}

async function asPlatformAdmin<T>(run: (tx: import("@prisma/client").Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const prisma = db();
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return run(tx);
    });
  } finally {
    await prisma.$disconnect();
  }
}

test("public email sign-up is refused", async ({ request }) => {
  const email = `e2e-walk-in-${Date.now()}@test.example`;
  const res = await request.post("/api/auth/sign-up/email", {
    data: { email, password: "E2eTestPass-123!", name: "Walk In" },
  });
  expect(res.status(), await res.text()).toBe(400);
  const prisma = db();
  try {
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  } finally {
    await prisma.$disconnect();
  }
});

// The invite makes the account server-side (#710): invite → set password → enrol 2FA → store admin.
// Owner and staff invites share one form (#781).
for (const role of ["owner", "staff"] as const) {
  test(`an invited ${role} sets a password, enrols 2FA with the setup key, saves backup codes that sign-in accepts`, async ({ page }) => {
    const email = `e2e-invitee-${role}-${Date.now()}@test.example`;
    const rawToken = randomBytes(32).toString("base64url");
    const inviteId = await asPlatformAdmin(async (tx) => {
      const store = await tx.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } });
      const owner = await tx.storeMembership.findFirstOrThrow({ where: { storeId: store.id, role: "owner" } });
      const invite = await tx.storeInvite.create({
        data: {
          storeId: store.id,
          email,
          role,
          tokenHash: createHash("sha256").update(rawToken).digest("hex"),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          invitedById: owner.userId,
        },
      });
      return invite.id;
    });

    try {
      mkdirSync(SHOTS, { recursive: true });
      await page.goto(`/invite/${rawToken}`);
      await expect(page.getByText("Join Mama Ngozi", { exact: false })).toBeVisible();
      await page.getByLabel("Full name").fill("Ngozi Invitee");
      await page.getByLabel("Password").fill("E2eInvitePass-123!");
      const enabled = page.waitForResponse((res) => res.url().includes("/api/auth/two-factor/enable"));
      await page.getByRole("button", { name: "Create account & continue" }).click();
      const enableRes = await enabled;
      expect(enableRes.status()).toBe(200);
      const totpURI = ((await enableRes.json()) as { totpURI: string }).totpURI;
      const secret = new URL(totpURI).searchParams.get("secret");
      if (!secret) throw new Error("TOTP URI has no secret");

      // AC1: the setup key shows as text with a copy button, for an authenticator on the same phone.
      await expect(page.getByText(secret.replace(/(.{4})(?=.)/g, "$1 "), { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Copy setup key" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/781-invite-${role}-setup-key.png`, fullPage: true });

      await page.getByLabel("Verification code").fill(generateTOTP(secret));
      await page.getByRole("button", { name: "Verify & join store" }).click();

      // AC2: the backup codes show once, with copy and download, before the owner moves on.
      await expect(page.getByRole("heading", { name: "Save your backup codes" })).toBeVisible({ timeout: 15_000 });
      const shown = (await page.locator("ul li").allTextContents()).map((code) => code.trim());
      expect(shown).toHaveLength(10);
      await expect(page.getByRole("button", { name: "Copy backup codes" })).toBeVisible();
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download backup codes" }).click();
      const download = await downloading;
      const chunks: Buffer[] = [];
      for await (const chunk of (await download.createReadStream()) as AsyncIterable<Buffer>) chunks.push(chunk);
      const file = Buffer.concat(chunks).toString("utf8");
      for (const code of shown) expect(file).toContain(code);
      await page.screenshot({ path: `${SHOTS}/781-invite-${role}-backup-codes.png`, fullPage: true });

      await page.getByRole("button", { name: /saved them/ }).click();
      await page.waitForURL((url) => url.pathname === "/store-admin", { timeout: 15_000 });
      await expect(page.getByRole("heading", { level: 1, name: "Mama Ngozi African Market" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/710-invite-store-admin.png`, fullPage: true });

      const prisma = db();
      try {
        const user = await prisma.user.findUniqueOrThrow({ where: { email } });
        expect(user).toMatchObject({ name: "Ngozi Invitee", emailVerified: true, role: "customer", twoFactorEnabled: true });
      } finally {
        await prisma.$disconnect();
      }

      // AC3: a code shown on the page is one that sign-in accepts.
      await page.context().clearCookies();
      await page.goto("/store-admin/sign-in?store=mama-ngozi");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill("E2eInvitePass-123!");
      await page.click("button[type='submit']");
      await page.getByRole("button", { name: "Lost your phone? Use a backup code" }).click();
      await page.getByLabel("Backup code").fill(shown[0]);
      await page.getByRole("button", { name: "Verify" }).click();
      await page.waitForURL((url) => url.pathname === "/store-admin", { timeout: 15_000 });
      await expect(page.getByRole("heading", { level: 1, name: "Mama Ngozi African Market" })).toBeVisible();
    } finally {
      await asPlatformAdmin(async (tx) => {
        const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
        await tx.storeInvite.deleteMany({ where: { id: inviteId } });
        if (!user) return;
        await tx.auditLog.deleteMany({ where: { actorId: user.id } });
        await tx.storeMembership.deleteMany({ where: { userId: user.id } });
        await tx.twoFactor.deleteMany({ where: { userId: user.id } });
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.account.deleteMany({ where: { userId: user.id } });
        await tx.user.delete({ where: { id: user.id } });
      });
    }
  });
}
