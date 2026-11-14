import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";
import { fakePayoutPaymentIntentId, FAKE_PAYOUT_ORDERS } from "../src/lib/stripe/fake-payouts";

const SLUG = "mama-ngozi";
const ACCOUNT = "acct_e2e548";
const NUMBERS = [54801, 54802, 54803];
const PROOF = process.env.PROOF_DIR ?? "test-results/payouts-548";

function db() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the payouts e2e");
  return new PrismaClient({ adapter: new PrismaPg(url) });
}

async function withStore<T>(run: (tx: import("@prisma/client").Prisma.TransactionClient, storeId: string) => Promise<T>): Promise<T> {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      return run(tx, store.id);
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function seed() {
  await withStore(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: { in: NUMBERS } } });
    await tx.store.update({ where: { id: storeId }, data: { stripeAccountId: ACCOUNT } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    for (const [i, o] of FAKE_PAYOUT_ORDERS.entries()) {
      await tx.order.create({
        data: {
          storeId, customerId: customer.id, number: NUMBERS[i], status: "DELIVERED", fulfillment: o.fulfillment,
          subtotalCents: o.capturedAmountCents, bufferCents: 0, totalAuthorizedCents: o.capturedAmountCents,
          totalCents: o.capturedAmountCents, capturedAmountCents: o.capturedAmountCents, platformFeeCents: o.platformFeeCents,
          serviceFeeCents: o.serviceFeeCents, tipCents: o.tipCents, deliveryFeeCents: o.deliveryFeeCents,
          paymentIntentId: fakePayoutPaymentIntentId(o.key, ACCOUNT),
        },
      });
    }
  });
}

async function cleanup() {
  await withStore(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: { in: NUMBERS } } });
    await tx.store.update({ where: { id: storeId }, data: { stripeAccountId: null } });
  });
}

async function shoot(page: Page, name: string) {
  mkdirSync(PROOF, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `${PROOF}/${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.describe.serial("Store payouts dashboard (#548)", () => {
  test.beforeAll(seed);
  test.afterAll(cleanup);

  test("owner sees payouts, opens one, downloads its CSV and opens Stripe", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/payouts?store=${SLUG}`);
    const list = page.getByTestId("payout-list");
    await expect(list.getByRole("link")).toHaveCount(2);
    await expect(list).toContainText("$34.35");
    await expect(list).toContainText("On the way");
    await shoot(page, "payouts-list");

    await list.getByRole("link", { name: /\$58\.84/ }).click();
    await expect(page.getByRole("heading", { name: "Payout of $58.84" })).toBeVisible();
    const table = page.getByTestId("payout-orders");
    await expect(table.getByRole("row", { name: /#54801/ })).toContainText("$36.79");
    await expect(table.getByRole("row", { name: /#54802/ })).toContainText("$22.05");
    await expect(table.getByRole("row", { name: "Payout total" })).toContainText("$58.84");
    await shoot(page, "payout-detail");

    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "CSV" }).click();
    const file = await (await download).path();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(file, "utf8")).toContain("#54801,45.50,3.00,0.00,1.71,10.00,36.79");

    await page.route("https://connect.stripe.com/**", (route) => route.fulfill({ body: "stripe express" }));
    await page.getByRole("button", { name: "Open Stripe dashboard" }).click();
    await expect(page).toHaveURL(`https://connect.stripe.com/express/fake-login/${ACCOUNT}`);
  });

  test("an unknown payout id shows not found", async ({ page }) => {
    await storeOwnerSignIn(page);
    const res = await page.goto(`/store-admin/payouts/po_someone_else?store=${SLUG}`);
    expect(res?.status()).toBe(404);
  });
});
