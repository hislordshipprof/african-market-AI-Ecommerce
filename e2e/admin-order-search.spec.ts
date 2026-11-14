import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const NUMBER = 18537;
const RUN = `e2e537${Date.now()}`;
const EMAIL = `${RUN}@example.com`;
const TOKEN = `trk_${RUN}_fulltokenvalue7c2d`;

async function asPlatformAdmin<T>(run: (tx: Prisma.TransactionClient, storeId: string) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } });
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return run(tx, store.id);
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

// One fixture order shared by the tests below, so they run in one worker.
test.describe.configure({ mode: "serial" });

let orderId = "";

test.beforeAll(async () => {
  orderId = await asPlatformAdmin(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: NUMBER } });
    const customer = await tx.customer.create({ data: { storeId, name: "Search Shopper", email: EMAIL, phone: "+1 555 018 5370" } });
    const variant = await tx.listingVariant.findFirstOrThrow({ where: { listing: { storeId } } });
    const order = await tx.order.create({
      data: {
        storeId,
        number: NUMBER,
        customerId: customer.id,
        status: "PARTIALLY_REFUNDED",
        fulfillment: "pickup",
        subtotalCents: 2500,
        bufferCents: 250,
        serviceFeeCents: 99,
        totalAuthorizedCents: 2849,
        capturedAmountCents: 2599,
        platformFeeCents: 99 + 102,
        paymentIntentId: `pi_${RUN}`,
        trackingToken: TOKEN,
        lines: { create: { listingVariantId: variant.id, qtyOrdered: 2, qtyPicked: 2, unitPriceCents: 1250 } },
      },
    });
    await tx.refundRequest.create({
      data: { storeId, orderId: order.id, paymentIntentId: `pi_${RUN}`, key: `${RUN}-refund`, amountCents: 1250, refundApplicationFee: false, state: "CREATED", providerStatus: "succeeded", providerRefundId: `re_${RUN}` },
    });
    return order.id;
  });
});

test.afterAll(async () => {
  await asPlatformAdmin(async (tx, storeId) => {
    await tx.auditLog.deleteMany({ where: { storeId, entityType: "order", entityId: orderId } });
    await tx.order.deleteMany({ where: { storeId, id: orderId } });
    await tx.customer.deleteMany({ where: { storeId, email: EMAIL } });
  });
});

test("an admin finds an order by store and number and reads its detail, and the view is audited", async ({ page }) => {
  await adminSignIn(page);
  await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Search orders" }).click();
  await expect(page.locator("h1")).toHaveText("Search orders");

  await page.getByLabel("Store").selectOption({ label: "Mama Ngozi African Market" });
  await page.getByLabel("Order number").fill(String(NUMBER));
  await page.getByRole("button", { name: "Search", exact: true }).click();

  const result = page.getByTestId(`order-result-${NUMBER}`);
  await expect(result).toBeVisible();
  await expect(page.getByTestId("order-results").locator("li")).toHaveCount(1);
  await result.click();

  await page.waitForURL(`**/admin/orders/search/${orderId}`);
  await expect(page.locator("h1")).toHaveText(`Order #${NUMBER}`);
  await expect(page.getByRole("navigation", { name: "Admin" }).locator("[aria-current='page']")).toHaveText("Search orders");
  await expect(page.getByTestId("payment-intent")).toHaveText(`pi_${RUN}`);
  await expect(page.getByTestId("authorized")).toHaveText("$28.49");
  await expect(page.getByTestId("captured")).toHaveText("$25.99");
  await expect(page.getByTestId("application-fee")).toHaveText("$2.01");
  await expect(page.getByTestId("refunded")).toHaveText("$12.50");
  await expect(page.getByTestId("refund-requests")).toContainText("succeeded");
  await expect(page.getByTestId("order-lines")).toContainText("Ordered 2 · Picked 2");
  await expect(page.getByTestId("tracking-hint")).toHaveText("ends …7c2d");
  expect(await page.content()).not.toContain(TOKEN);
  // Read only: the page itself has no buttons or forms; only the shell's menu does.
  await expect(page.locator("#admin-main").locator("button, form")).toHaveCount(0);

  const views = await asPlatformAdmin((tx, storeId) =>
    tx.auditLog.findMany({ where: { storeId, entityType: "order", entityId: orderId, action: "platform.order_view" } }),
  );
  expect(views.length).toBeGreaterThanOrEqual(1);
  expect(views.every((row) => row.actorEmail === ADMIN_EMAIL)).toBe(true);
});

test("email search matches the whole address only", async ({ page }) => {
  await adminSignIn(page);
  await page.goto("/admin/orders/search");
  await page.getByLabel("Customer email").fill(EMAIL.toUpperCase());
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId(`order-result-${NUMBER}`)).toBeVisible();

  await page.getByLabel("Customer email").fill(`a${EMAIL}`);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No orders match." })).toBeVisible();
});

test("search and order detail send anyone who is not signed in to the admin sign-in", async ({ page }) => {
  await page.goto("/admin/orders/search");
  await expect(page).toHaveURL(/\/admin\/sign-in/);
  await page.goto(`/admin/orders/search/${orderId}`);
  await expect(page).toHaveURL(/\/admin\/sign-in/);
});
