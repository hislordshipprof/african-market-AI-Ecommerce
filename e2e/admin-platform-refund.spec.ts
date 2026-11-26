import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { deleteInboxOrder, insertInboxOrder } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const ORDERS_URL = "/store-admin/orders?store=mama-ngozi";
const NUMBER = 18538;
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

/** Proof screenshots at 390 and 1280, light and dark, only when PROOF_DIR is set. */
async function proof(page: Page, name: string) {
  if (!PROOF) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `${PROOF}/538-${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.afterAll(async () => {
  await deleteInboxOrder(NUMBER);
});

test("an admin refunds a completed order once from the order detail, and the store sees it was the platform team", async ({ browser }) => {
  test.setTimeout(120_000);
  await insertInboxOrder({ number: NUMBER, status: "PICKING", capturedAmountCents: null, seedHold: true });

  // The store picks and hands off, so the server's Stripe captures the payment for real.
  const store = await browser.newPage();
  await storeOwnerSignIn(store);
  await store.goto(ORDERS_URL);
  await store.locator("button", { hasText: `#${NUMBER}` }).click();
  const pick = store.getByTestId("order-panel").getByRole("button", { name: "Pick", exact: true });
  for (let left = await pick.count(); left > 0; left -= 1) {
    await pick.first().click();
    await expect(pick).toHaveCount(left - 1);
  }
  await store.getByRole("button", { name: "Mark ready" }).click();
  await store.getByRole("button", { name: "Hand off" }).click();
  const order = await expect
    .poll(() => asPlatformAdmin((tx) => tx.order.findFirst({ where: { number: NUMBER, store: { slug: "mama-ngozi" } } })), { timeout: 15_000 })
    .toMatchObject({ status: "COMPLETED" })
    .then(() => asPlatformAdmin((tx) => tx.order.findFirstOrThrow({ where: { number: NUMBER, store: { slug: "mama-ngozi" } } })));

  const admin = await browser.newPage();
  await adminSignIn(admin);
  await admin.goto(`/admin/orders/search/${order.id}`);
  const form = admin.getByTestId("platform-refund-form");
  await expect(form).toContainText(`up to $${((order.capturedAmountCents ?? 0) / 100).toFixed(2)}`);

  // Above what is left: refused, nothing written.
  await form.getByLabel("Amount").fill(((order.capturedAmountCents ?? 0) / 100 + 1).toFixed(2));
  await form.getByLabel("Reason").fill("Courier crushed the eggs; store did not answer");
  await form.getByRole("button", { name: /^Refund/ }).click();
  await expect(form.getByRole("status")).toContainText("more than is left to refund");

  await form.getByLabel("Amount").fill("5.00");
  await proof(admin, "detail-form");
  const button = form.getByRole("button", { name: "Refund $5.00" });
  await button.dblclick();
  await expect(admin.getByTestId("order-status")).toHaveText("PARTIALLY_REFUNDED", { timeout: 15_000 });
  await expect(admin.getByTestId("refunded")).toHaveText("$5.00");
  await expect(admin.getByTestId("order-timeline")).toContainText("platform_refund");
  await proof(admin, "detail-refunded");

  const written = await asPlatformAdmin(async (tx) => ({
    requests: await tx.refundRequest.findMany({ where: { orderId: order.id } }),
    audits: await tx.auditLog.findMany({ where: { entityId: order.id, action: "platform_refund" } }),
    notices: await tx.notificationLog.findMany({ where: { orderId: order.id, event: "refunded" } }),
  }));
  expect(written.requests).toHaveLength(1);
  expect(written.requests[0]).toMatchObject({ amountCents: 500, providerStatus: "succeeded" });
  expect(written.audits).toHaveLength(1);
  expect(written.audits[0]).toMatchObject({ actorEmail: ADMIN_EMAIL });
  expect(written.audits[0].after).toMatchObject({ amountCents: 500, reason: "Courier crushed the eggs; store did not answer" });
  expect(new Set(written.notices.map((row) => row.channel)).size).toBe(written.notices.length);
  expect(written.notices.length).toBeGreaterThan(0);

  await store.goto(ORDERS_URL);
  await store.locator("button", { hasText: `#${NUMBER}` }).click();
  await expect(store.getByTestId("refunded-by-platform")).toHaveText("Refunded by the platform team");
  await proof(store, "store-inbox");
});
