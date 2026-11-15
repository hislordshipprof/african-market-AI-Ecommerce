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
const NUMBER = 18539;
const MATCHED = "du_e2e_539_matched";
const ORPHAN = "du_e2e_539_orphan";
const PROOF = process.env.PROOF_DIR;

async function asPlatformAdmin<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      // The pg adapter sends timestamptz without an offset; the app pins UTC (src/lib/db.ts), so this client does too.
      await tx.$executeRaw`SELECT set_config('TimeZone', 'UTC', true)`;
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
      await page.screenshot({ path: `${PROOF}/539-${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function removeDisputes() {
  await asPlatformAdmin((tx) => tx.paymentDispute.deleteMany({ where: { stripeDisputeId: { in: [MATCHED, ORPHAN] } } }));
}

test.afterAll(async () => {
  await removeDisputes();
  await deleteInboxOrder(NUMBER);
});

test("an open dispute is in the admin queue by deadline with a Stripe link, and the store sees the order badged Disputed", async ({ browser }) => {
  test.setTimeout(90_000);
  await removeDisputes();
  await insertInboxOrder({ number: NUMBER, status: "COMPLETED", capturedAmountCents: 4250 });
  const order = await asPlatformAdmin((tx) => tx.order.findFirstOrThrow({ where: { number: NUMBER, store: { slug: "mama-ngozi" } } }));
  const soon = new Date(Date.now() + 5 * 3_600_000);
  await asPlatformAdmin((tx) => tx.paymentDispute.createMany({
    data: [
      {
        stripeDisputeId: MATCHED, storeId: order.storeId, orderId: order.id, chargeId: "ch_e2e_539", paymentIntentId: order.paymentIntentId,
        amountCents: 4250, currency: "usd", reason: "product_not_received", status: "needs_response", evidenceDueBy: soon,
        lastEventAt: new Date(), notifiedAt: new Date(),
      },
      {
        stripeDisputeId: ORPHAN, chargeId: "ch_e2e_539_orphan", amountCents: 1999, currency: "usd", reason: "fraudulent",
        status: "warning_needs_response", evidenceDueBy: new Date(soon.getTime() + 3 * 86_400_000), lastEventAt: new Date(), notifiedAt: new Date(),
      },
    ],
  }));

  const admin = await browser.newPage();
  await adminSignIn(admin);
  await admin.getByRole("link", { name: "Disputes" }).first().click();
  await admin.waitForURL("**/admin/disputes");
  const matched = admin.getByTestId(`dispute-row-${MATCHED}`);
  await expect(matched).toContainText(`#${NUMBER}`);
  await expect(matched).toContainText("$42.50");
  await expect(matched).toContainText("Order not received");
  await expect(matched).toContainText(/Due in [45] h/);
  await expect(matched.getByRole("link", { name: /Open in Stripe/ })).toHaveAttribute("href", `https://dashboard.stripe.com/test/disputes/${MATCHED}`);
  await expect(admin.getByTestId(`dispute-row-${ORPHAN}`)).toContainText("No matching order");
  const ids = await admin.locator("[data-testid^='dispute-row-du_e2e_539']").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid")));
  expect(ids).toEqual([`dispute-row-${MATCHED}`, `dispute-row-${ORPHAN}`]);
  await proof(admin, "admin-disputes");

  const store = await browser.newPage();
  await storeOwnerSignIn(store);
  await store.goto("/store-admin/orders?store=mama-ngozi");
  const row = store.locator("button", { hasText: `#${NUMBER}` });
  await expect(row.getByTestId("disputed-badge")).toBeVisible();
  await proof(store, "store-inbox");
  await row.click();
  await expect(store.getByTestId("order-disputed")).toBeVisible();
  await proof(store, "store-order");
});
