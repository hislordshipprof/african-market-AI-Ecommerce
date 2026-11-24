import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { deleteInboxOrder, insertInboxOrder } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";
import { storeUrl } from "./urls";

const ORDERS_URL = "/store-admin/orders?store=mama-ngozi";
const NUMBER = 18798;
const TOKEN = `e2e-798-${Date.now()}`;
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

/** Proof screenshots at 390 dark and 1280 light, only when PROOF_DIR is set. */
async function proof(page: Page, name: string) {
  if (!PROOF) return;
  for (const [width, scheme] of [[390, "dark"], [1280, "light"]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `${PROOF}/798-${name}-${width}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.afterAll(async () => {
  await deleteInboxOrder(NUMBER);
});

test("#798: the owner opens a past order, refunds one item once, and the shopper's receipt names it", async ({ page }) => {
  test.setTimeout(120_000);
  await insertInboxOrder({ number: NUMBER, status: "PICKING", capturedAmountCents: null, seedHold: true });

  // Pick, ready and hand off, so the server's Stripe captures the payment.
  await storeOwnerSignIn(page);
  await page.goto(ORDERS_URL);
  await page.locator("button", { hasText: `#${NUMBER}` }).click();
  const pick = page.getByRole("button", { name: "Pick" });
  for (let left = await pick.count(); left > 0; left -= 1) {
    await pick.first().click();
    await expect(pick).toHaveCount(left - 1);
  }
  await page.getByRole("button", { name: "Mark ready" }).click();
  // From Ready onward the owner can refund in the inbox, and mark a pickup as not collected.
  await expect(page.getByRole("button", { name: "Refund" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Not collected" })).toBeVisible();
  await page.getByRole("button", { name: "Refund" }).click();
  await proof(page, "inbox-dialog");
  await page.getByRole("button", { name: "Keep order" }).click();
  await page.getByRole("button", { name: "Hand off" }).click();
  const order = await expect
    .poll(() => asPlatformAdmin((tx) => tx.order.findFirst({ where: { number: NUMBER, store: { slug: "mama-ngozi" } } })), { timeout: 15_000 })
    .toMatchObject({ status: "COMPLETED" })
    .then(() => asPlatformAdmin((tx) => tx.order.findFirstOrThrow({ where: { number: NUMBER, store: { slug: "mama-ngozi" } }, include: { lines: true } })));
  await asPlatformAdmin((tx) => tx.order.update({ where: { id: order.id }, data: { trackingToken: TOKEN } }));

  await page.goto("/store-admin/orders/past?store=mama-ngozi");
  await page.getByRole("link", { name: `Order #${NUMBER}` }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Order #${NUMBER}`) })).toBeVisible();
  await page.getByRole("button", { name: "Refund" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^One more / }).first().click();
  await dialog.getByLabel("Reason").fill("Bruised on the way out");
  await proof(page, "past-dialog");
  await dialog.getByRole("button", { name: "Refund", exact: true }).dblclick();
  await expect(page.getByTestId("past-order-lines")).toContainText("Refunded 1", { timeout: 15_000 });
  await expect(page.getByTestId("past-order-refunds")).toContainText("Bruised on the way out");
  // The order's one unit is all its goods, so the refund with its fee share leaves the order Refunded.
  await expect(page.getByRole("heading", { name: /Refunded/ })).toBeVisible();
  await proof(page, "past-detail");

  const written = await asPlatformAdmin(async (tx) => ({
    requests: await tx.refundRequest.findMany({ where: { orderId: order.id } }),
    audits: await tx.auditLog.findMany({ where: { entityId: order.id, action: "store_refund" } }),
  }));
  expect(written.requests).toHaveLength(1);
  expect(written.audits).toHaveLength(1);

  await page.goto(`${storeUrl("mama-ngozi")}/order/${TOKEN}`);
  await expect(page.getByText(/^Refunded 1 × /)).toBeVisible();
  await proof(page, "receipt");
});
