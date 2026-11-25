import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
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

async function seedInvite(email: string, role: "owner" | "staff", rawToken: string): Promise<string> {
  return asPlatformAdmin(async (tx) => {
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
}

async function removeInvitee(email: string, inviteIds: string[]): Promise<void> {
  await asPlatformAdmin(async (tx) => {
    const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
    await tx.storeInvite.deleteMany({ where: { id: { in: inviteIds } } });
    if (!user) return;
    await tx.storeInvite.deleteMany({ where: { invitedById: user.id } });
    await tx.auditLog.deleteMany({ where: { actorId: user.id } });
    await tx.storeMembership.deleteMany({ where: { userId: user.id } });
    await tx.twoFactor.deleteMany({ where: { userId: user.id } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.account.deleteMany({ where: { userId: user.id } });
    await tx.user.delete({ where: { id: user.id } });
  });
}

async function acceptInvite(page: Page, rawToken: string): Promise<void> {
  await page.goto(`/invite/${rawToken}`);
  await expect(page.getByText("Join Mama Ngozi", { exact: false })).toBeVisible();
  await page.getByLabel("Full name").fill("Ngozi Invitee");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account & continue" }).click();
  await page.waitForURL((url) => url.pathname === "/store-admin/two-factor", { timeout: 15_000 });
}

/** On the store 2FA page: Set up now, the authenticator, the backup codes. Returns the codes shown. */
async function setUpNow(page: Page, shot?: string): Promise<string[]> {
  await page.getByRole("button", { name: "Set up now" }).click();
  await page.getByLabel("Current password").fill(PASSWORD);
  const enabled = page.waitForResponse((res) => res.url().includes("/api/auth/two-factor/enable"));
  await page.getByRole("button", { name: "Begin setup" }).click();
  const enableRes = await enabled;
  expect(enableRes.status()).toBe(200);
  const secret = new URL(((await enableRes.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI has no secret");
  if (shot) await page.screenshot({ path: shot, fullPage: true });
  await page.getByLabel("Verification code").fill(generateTOTP(secret));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { name: "Save your backup codes" })).toBeVisible({ timeout: 15_000 });
  const shown = (await page.locator("ul li").allTextContents()).map((code) => code.trim());
  expect(shown).toHaveLength(10);
  await page.getByRole("button", { name: /saved them/ }).click();
  return shown;
}

const PASSWORD = "E2eInvitePass-123!";

/** Proof at desktop and at a 390px phone (#840). */
async function shotBothWidths(page: Page, name: string): Promise<void> {
  const desktop = page.viewportSize();
  // Toasts slide in and re-settle after a resize; the shot waits for them.
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/${name}-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/${name}-390.png` });
  if (desktop) await page.setViewportSize(desktop);
}
const REMINDER = "Two-factor reminder";

// The invite makes the account server-side (#710); 2FA is then offered, not forced (#840).
test("an invited staff member sets a password, chooses Set up now, and the backup codes work at sign-in", async ({ page }) => {
  const email = `e2e-invitee-staff-${Date.now()}@test.example`;
  const rawToken = randomBytes(32).toString("base64url");
  const inviteId = await seedInvite(email, "staff", rawToken);
  try {
    mkdirSync(SHOTS, { recursive: true });
    await acceptInvite(page, rawToken);
    await expect(page.getByRole("link", { name: "Remind me later" })).toBeVisible();
    const shown = await setUpNow(page, `${SHOTS}/840-staff-setup.png`);
    await page.waitForURL((url) => url.pathname === "/store-admin", { timeout: 15_000 });
    await expect(page.getByRole("complementary", { name: "Store admin" }).getByText("Mama Ngozi African Market")).toBeVisible();
    await expect(page.getByRole("complementary", { name: REMINDER })).toHaveCount(0);

    const prisma = db();
    try {
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user).toMatchObject({ name: "Ngozi Invitee", emailVerified: true, role: "customer", twoFactorEnabled: true });
    } finally {
      await prisma.$disconnect();
    }

    // #840 AC4: with 2FA on, the password alone is not enough; a backup code shown on the page works.
    await page.context().clearCookies();
    await page.goto("/store-admin/sign-in?store=mama-ngozi");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.click("button[type='submit']");
    await page.getByRole("button", { name: "Lost your phone? Use a backup code" }).click();
    await page.getByLabel("Backup code").fill(shown[0]);
    await page.getByRole("button", { name: "Verify" }).click();
    await page.waitForURL((url) => url.pathname === "/store-admin", { timeout: 15_000 });
    await expect(page.getByRole("complementary", { name: "Store admin" }).getByText("Mama Ngozi African Market")).toBeVisible();
  } finally {
    await removeInvitee(email, [inviteId]);
  }
});

test("an invited owner chooses Remind me later, sees the reminder, and an invite needs 2FA set up first, then works", async ({ page }) => {
  const email = `e2e-invitee-owner-${Date.now()}@test.example`;
  const teammate = `e2e-teammate-${Date.now()}@test.example`;
  const rawToken = randomBytes(32).toString("base64url");
  const inviteId = await seedInvite(email, "owner", rawToken);
  try {
    mkdirSync(SHOTS, { recursive: true });
    await acceptInvite(page, rawToken);
    await expect(page.getByRole("button", { name: "Set up now" })).toBeVisible();
    await shotBothWidths(page, "840-setup-offer");
    await page.getByRole("link", { name: "Remind me later" }).click();
    await page.waitForURL((url) => url.pathname === "/store-admin", { timeout: 15_000 });
    await expect(page.getByRole("complementary", { name: "Store admin" }).getByText("Mama Ngozi African Market")).toBeVisible();
    const reminder = page.getByRole("complementary", { name: REMINDER });
    await expect(reminder).toBeVisible();
    await expect(reminder.getByRole("link", { name: "Set up 2FA" })).toBeVisible();
    await shotBothWidths(page, "840-reminder-dashboard");

    // Hidden for this visit only: gone on the next page, back in a new visit.
    await page.getByRole("button", { name: "Hide the reminder for this visit" }).click();
    await expect(reminder).toHaveCount(0);
    await page.goto("/store-admin/team?store=mama-ngozi");
    await expect(page.getByRole("complementary", { name: REMINDER })).toHaveCount(0);
    const nextVisit = await page.context().newPage();
    await nextVisit.goto("/store-admin?store=mama-ngozi");
    await expect(nextVisit.getByRole("complementary", { name: REMINDER })).toBeVisible();
    await nextVisit.close();

    // A password-only sign-in reaches store admin; the 2FA offer comes first.
    await page.context().clearCookies();
    await page.goto("/store-admin/sign-in?store=mama-ngozi&next=%2Fstore-admin%2Fteam%3Fstore%3Dmama-ngozi");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.click("button[type='submit']");
    await page.waitForURL((url) => url.pathname === "/store-admin/two-factor", { timeout: 15_000 });
    await page.getByRole("link", { name: "Remind me later" }).click();
    await page.waitForURL((url) => url.pathname === "/store-admin/team", { timeout: 15_000 });

    // #840 AC3: the server refuses the invite and links to setup, which comes back to this page.
    await page.getByLabel("Email address").fill(teammate);
    await page.getByRole("button", { name: /send invite/i }).click();
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: /two-factor/i });
    await expect(toast).toBeVisible();
    await shotBothWidths(page, "840-invite-needs-2fa");
    await asPlatformAdmin(async (tx) => expect(await tx.storeInvite.count({ where: { email: teammate } })).toBe(0));
    await toast.getByRole("button", { name: "Set up 2FA" }).click();
    await page.waitForURL((url) => url.pathname === "/store-admin/two-factor", { timeout: 15_000 });
    await setUpNow(page);
    await page.waitForURL((url) => url.pathname === "/store-admin/team", { timeout: 15_000 });
    await expect(page.getByRole("complementary", { name: REMINDER })).toHaveCount(0);

    await page.getByLabel("Email address").fill(teammate);
    await page.getByRole("button", { name: /send invite/i }).click();
    await expect.poll(() => asPlatformAdmin((tx) => tx.storeInvite.count({ where: { email: teammate } }))).toBe(1);
  } finally {
    await asPlatformAdmin((tx) => tx.storeInvite.deleteMany({ where: { email: teammate } }));
    await removeInvitee(email, [inviteId]);
  }
});
