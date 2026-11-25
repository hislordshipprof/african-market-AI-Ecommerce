import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";
import { laneSmokePort, reservePort, startSpawnedServer } from "./spawned-server";

const SLUG = "mama-ngozi";
const SHOTS = "screenshots";
const SENT = "e2e-809-sent@example.com";
const UNSENT = "e2e-809-unsent@example.com";

function db() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the team invites e2e");
  return new PrismaClient({ adapter: new PrismaPg(url) });
}

async function inviteFor(email: string) {
  const prisma = db();
  try {
    const [, , invite] = await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.storeInvite.findFirst({ where: { email, usedAt: null } }),
    ]);
    return invite;
  } finally {
    await prisma.$disconnect();
  }
}

async function clearInvites() {
  const prisma = db();
  try {
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.storeInvite.deleteMany({ where: { email: { in: [SENT, UNSENT] } } }),
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

async function shoot(page: Page, name: string) {
  for (const [label, size] of [["1440px", { width: 1440, height: 1000 }], ["390px", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await page.screenshot({ path: `${SHOTS}/${name}-${label}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

test.describe.configure({ mode: "serial" });

test.describe("team invites (#809)", () => {
  test.beforeAll(clearInvites);
  test.afterAll(clearInvites);

  test("the owner resends a pending invite with a fresh link and revokes it", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/team?store=${SLUG}`);
    await page.getByLabel("Email address").fill(SENT);
    await page.getByRole("button", { name: "Send invite" }).click();
    await expect(page.getByText(`Invitation sent to ${SENT}`)).toBeVisible();
    await expect(page.getByRole("button", { name: `Resend invite to ${SENT}` })).toBeVisible();
    await shoot(page, "809-team-pending");

    const before = await inviteFor(SENT);
    await page.getByRole("button", { name: `Resend invite to ${SENT}` }).click();
    await expect(page.getByText(`Invitation sent again to ${SENT}`)).toBeVisible();
    const after = await inviteFor(SENT);
    expect(after?.id).toBe(before?.id);
    expect(after?.tokenHash).not.toBe(before?.tokenHash);

    await page.getByRole("button", { name: `Revoke invite to ${SENT}` }).click();
    await expect(page.getByText(`Invitation to ${SENT} revoked`)).toBeVisible();
    await expect(page.getByRole("button", { name: `Resend invite to ${SENT}` })).toHaveCount(0);
    expect(await inviteFor(SENT)).toBeNull();
  });

  // The lane server mails into the in-memory sink, so this boots one with no email provider.
  test("when the email fails the owner reads a plain sentence and can share the link; revoking stops it", async ({ page }) => {
    test.setTimeout(240_000);
    const port = await reservePort(laneSmokePort());
    const origin = `http://localhost:${port}`;
    const running = await startSpawnedServer({
      command: `pnpm exec next start -p ${port}`,
      shell: true,
      cwd: process.cwd(),
      port,
      env: {
        ...process.env,
        CI: "",
        RESEND_API_KEY: "",
        E2E_FAKE_ASSISTANT: "",
        VERCEL_ENV: "preview",
        E2E_STORE_OVERRIDE: "1",
        VERCEL: "",
        STRIPE_SECRET_KEY: "",
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_TRUSTED_ORIGINS: origin,
      },
      healthUrl: `http://127.0.0.1:${port}/api/health`,
      healthOk: (status) => status === 200 || status === 503,
    });
    try {
      await storeOwnerSignIn(page, origin);
      await page.goto(`${origin}/store-admin/team?store=${SLUG}`);
      await page.getByLabel("Email address").fill(UNSENT);
      await page.getByRole("button", { name: "Send invite" }).click();
      const notice = page.getByRole("status").filter({ hasText: "Invite saved" });
      await expect(notice).toContainText("Invite saved, but the email could not be sent. Resend it or share the link.");
      await expect(page.getByText("validation_error")).toHaveCount(0);
      const link = await page.getByLabel(`Invite link for ${UNSENT}`).inputValue();
      expect(link).toContain("/invite/");
      await shoot(page, "809-team-email-failed");

      const invitee = await page.context().newPage();
      await invitee.goto(link);
      await expect(invitee.getByLabel("Email")).toHaveValue(UNSENT);

      await page.getByRole("button", { name: `Revoke invite to ${UNSENT}` }).click();
      await expect(page.getByText(`Invitation to ${UNSENT} revoked`)).toBeVisible();
      await invitee.goto(link);
      await expect(invitee.getByText("Invalid invitation link")).toBeVisible();
      await shoot(invitee, "809-invite-revoked");
      await invitee.close();
    } finally {
      await running.stop();
    }
  });
});
