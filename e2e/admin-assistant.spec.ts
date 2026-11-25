import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const STORE_ID = "e2e-store-831-stuck";
const STORE_NAME = "E2E Stuck Market 831";
const PROOF = process.env.PROOF_DIR;

async function asPlatformAdmin<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
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

async function adminSignIn(page: Page) {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").waitFor({ state: "visible" });
  await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
  await page.click("button[type='submit']");
  await page.waitForURL("**/admin");
}

async function proof(page: Page, name: string) {
  if (!PROOF) return;
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${PROOF}/831-${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function cleanUp() {
  await asPlatformAdmin(async (tx) => {
    const admin = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
    if (admin[0]) await tx.adminAssistantConversation.deleteMany({ where: { userId: admin[0].id } });
    await tx.store.deleteMany({ where: { id: STORE_ID } });
  });
}

test.beforeEach(async () => {
  await cleanUp();
  // Prisma writes these naive timestamps in UTC; the column default uses the session time zone and would sort this store hours old.
  await asPlatformAdmin((tx) => tx.$executeRaw`
    INSERT INTO stores (id, name, slug, status, doordash_registration_error, created_at, updated_at)
    VALUES (${STORE_ID}, ${STORE_NAME}, 'e2e-stuck-market-831', 'setup', 'Pickup address not accepted',
      now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`);
});

test.afterEach(cleanUp);

test("an admin asks which stores are stuck in onboarding and opens the store from the answer (#831)", async ({ page }) => {
  await adminSignIn(page);
  await page.getByRole("navigation").getByRole("link", { name: "Assistant" }).first().click();
  await expect(page.getByRole("heading", { name: "Assistant", level: 1 })).toBeVisible();
  await proof(page, "empty");

  await page.getByLabel("Message").fill("Which stores are stuck in onboarding?");
  await page.getByRole("button", { name: "Send" }).click();

  const answer = page.getByRole("region", { name: "Conversation" });
  await expect(answer.getByText("still in setup")).toBeVisible();
  const store = page.getByRole("region", { name: "Open in admin" }).getByRole("link", { name: STORE_NAME });
  await expect(store).toBeVisible();
  await proof(page, "answer");

  await store.click();
  await page.waitForURL(`**/admin/stores/${STORE_ID}`);
  await expect(page.getByText(STORE_NAME).first()).toBeVisible();

  const logged = await asPlatformAdmin((tx) => tx.auditLog.count({
    where: { actorEmail: ADMIN_EMAIL, action: "admin_assistant.tool", after: { path: ["tool"], equals: "find_stores" } },
  }));
  expect(logged).toBeGreaterThan(0);
});
