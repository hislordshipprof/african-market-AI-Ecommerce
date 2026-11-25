import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const STORE_ID = "e2e-store-834-golive";
const STORE_SLUG = "e2e-golive-834";
const STORE_NAME = "E2E Stuck Market 834";
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

async function proof(page: Page, name: string, fullPage = true) {
  if (!PROOF) return;
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${PROOF}/834-${name}-${width}.png`, fullPage });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

async function cleanUp() {
  await asPlatformAdmin(async (tx) => {
    const admin = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
    if (admin[0]) await tx.adminAssistantConversation.deleteMany({ where: { userId: admin[0].id } });
    await tx.auditLog.deleteMany({ where: { storeId: STORE_ID } });
    await tx.storeSubscription.deleteMany({ where: { storeId: STORE_ID } });
    await tx.store.deleteMany({ where: { id: STORE_ID } });
  });
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  await cleanUp();
  await asPlatformAdmin((tx) => tx.$executeRaw`INSERT INTO stores (id, name, slug, status, address_line1, zip, created_at, updated_at)
    VALUES (${STORE_ID}, ${STORE_NAME}, ${STORE_SLUG}, 'setup', '1 Setup Way', '77002', now() - interval '5 days', now())`);
});

test.afterEach(cleanUp);

test("the assistant opens with today's briefing, and one tap asks about the stores stuck in setup (#834)", async ({ page }) => {
  await adminSignIn(page);
  await page.goto("/admin/assistant");
  const today = page.getByRole("region", { name: "Today" });
  await expect(today.getByText(/need(s)? an admin today/)).toBeVisible();
  const stuck = today.getByRole("listitem").filter({ hasText: "in setup for more than 3 days" });
  await expect(stuck.getByText(STORE_NAME, { exact: false })).toBeVisible();
  await proof(page, "briefing");

  await stuck.getByRole("button", { name: "Ask the assistant" }).click();
  const conversation = page.getByRole("region", { name: "Conversation" });
  await expect(conversation.getByText("These stores are still in setup.", { exact: false })).toBeVisible();
  await expect(conversation.getByRole("link", { name: STORE_NAME })).toBeVisible();
});

test("a forced go-live card needs a typed reason, which lands in the activity view (#834)", async ({ page }) => {
  await adminSignIn(page);
  await page.goto("/admin/assistant");
  await send(page, `Force go-live for ${STORE_SLUG}`);
  const card = page.getByRole("article", { name: "Force go-live" });
  await expect(card).toBeVisible();
  await expect(card.getByText("This cannot be undone", { exact: false }).or(card.getByText("Shoppers can order", { exact: false }))).toBeVisible();
  const confirm = card.getByRole("button", { name: "Confirm" });
  await expect(confirm).toBeDisabled();
  await proof(page, "reason-card");

  const reason = "Pilot store, menu goes up tonight";
  await card.getByLabel(/Reason/).fill(reason);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(card.getByText("Done.")).toBeVisible();
  expect(await asPlatformAdmin((tx) => tx.store.findUniqueOrThrow({ where: { id: STORE_ID }, select: { status: true } }))).toEqual({ status: "active" });
  await proof(page, "reason-confirmed");

  await page.goto("/admin/assistant/activity");
  const confirmed = page.getByRole("listitem").filter({ hasText: "force_go_live" }).filter({ hasText: "Confirmed" }).first();
  await expect(confirmed.getByText(reason, { exact: false })).toBeVisible();
  await proof(page, "activity", false);
});
