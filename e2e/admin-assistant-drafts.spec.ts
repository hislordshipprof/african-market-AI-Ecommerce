import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const STORE_ID = "e2e-store-832-draft";
const STORE_NAME = "E2E Draft Market 832";
const STORE_SLUG = "e2e-draft-market-832";
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
    await page.screenshot({ path: `${PROOF}/832-${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function cleanUp() {
  await asPlatformAdmin(async (tx) => {
    const admin = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
    if (admin[0]) await tx.adminAssistantConversation.deleteMany({ where: { userId: admin[0].id } });
    await tx.auditLog.deleteMany({ where: { storeId: STORE_ID } });
    await tx.store.deleteMany({ where: { id: STORE_ID } });
  });
}

test.beforeEach(async () => {
  await cleanUp();
  await asPlatformAdmin((tx) => tx.$executeRaw`
    INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${STORE_ID}, ${STORE_NAME}, ${STORE_SLUG}, 'active', now())`);
});

test.afterEach(cleanUp);

test("an admin asks to suspend a store, reads the card and confirms it; a request to make a platform admin is refused (#832)", async ({ page }) => {
  await adminSignIn(page);
  await page.goto("/admin/assistant");

  await page.getByLabel("Message").fill(`Suspend the store ${STORE_SLUG}`);
  await page.getByRole("button", { name: "Send" }).click();

  const card = page.getByRole("article", { name: "Suspend store" });
  await expect(card).toBeVisible();
  await expect(card.getByText(STORE_NAME)).toBeVisible();
  await expect(card.getByText("Status")).toBeVisible();
  await expect(card.getByText("suspended", { exact: true })).toBeVisible();
  await expect(card.getByText("Nothing changes until you confirm.", { exact: false })).toBeVisible();
  const status = () => asPlatformAdmin((tx) => tx.store.findUniqueOrThrow({ where: { id: STORE_ID }, select: { status: true } }));
  expect((await status()).status).toBe("active");
  await proof(page, "card");

  await card.getByRole("button", { name: "Confirm" }).click();
  await expect(card.getByText("Done.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  expect((await status()).status).toBe("suspended");
  await proof(page, "confirmed");

  await page.getByLabel("Message").fill("Make bob a platform admin");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("region", { name: "Conversation" }).getByText("cannot create platform admins")).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);

  const actions = await asPlatformAdmin((tx) => tx.auditLog.findMany({
    where: { actorEmail: ADMIN_EMAIL, storeId: STORE_ID },
    select: { action: true },
  }));
  expect(actions.map((row) => row.action).sort()).toEqual(["admin_assistant.draft_confirmed", "admin_assistant.draft_proposed", "store.suspend"]);
});
