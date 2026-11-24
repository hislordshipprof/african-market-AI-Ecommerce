import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const MONTH = "2032-03";
const NUMBERS = [54601, 54602];

async function withMama<T>(run: (tx: Prisma.TransactionClient, storeId: string) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } });
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      return run(tx, store.id);
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function removeFixture() {
  await withMama((tx, storeId) => tx.order.deleteMany({ where: { storeId, number: { in: NUMBERS } } }));
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

test.describe("platform fee ledger", () => {
  // One worker owns the fixture: parallel workers would each run beforeAll and collide on the order numbers.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await removeFixture();
    await withMama(async (tx, storeId) => {
      const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
      const base = { storeId, customerId: customer.id, subtotalCents: 5000, bufferCents: 500, totalAuthorizedCents: 9000 };
      // The ADR-0021 example: $60 goods + $8.99 courier + $1.80 service fee; the platform keeps $1.49.
      await tx.order.create({
        data: {
          ...base, number: NUMBERS[0], status: "DELIVERED", fulfillment: "courier", capturedAmountCents: 7079,
          serviceFeeCents: 180, deliveryFeeCents: 899, platformFeeCents: 384, readyAt: new Date("2032-03-10T15:00:00Z"),
        },
      });
      // Pickup $20 + $3 tip + $0.99 fee, then a $10.30 issue refund that returns $0.84 of the $1.96 fee.
      const pickup = await tx.order.create({
        data: {
          ...base, number: NUMBERS[1], status: "PARTIALLY_REFUNDED", fulfillment: "pickup", capturedAmountCents: 2399,
          serviceFeeCents: 99, tipCents: 300, platformFeeCents: 196, readyAt: new Date("2032-03-11T15:00:00Z"),
        },
      });
      await tx.refundRequest.create({
        data: {
          storeId, orderId: pickup.id, paymentIntentId: "pi_e2e_ledger", key: `e2e-ledger-${Date.now()}`, amountCents: 1030,
          refundApplicationFee: true, state: "CREATED", providerStatus: "succeeded",
          createdAt: new Date("2032-03-12T09:00:00Z"), succeededAt: new Date("2032-03-12T09:00:00Z"),
        },
      });
    });
  });

  test.afterAll(removeFixture);

  test("is for platform admins only", async ({ page, request }) => {
    await page.goto(`/admin/billing/ledger?month=${MONTH}`);
    await expect(page).toHaveURL(/\/admin\/sign-in/);
    const csv = await request.get(`/api/admin/billing/ledger/export?month=${MONTH}`);
    expect(csv.status()).toBe(401);
  });

  test("shows each order to the cent, labels the UTC month, and downloads the same rows", async ({ page }) => {
    await adminSignIn(page);
    await page.goto(`/admin/billing/ledger?month=${MONTH}`);
    await expect(page.locator("h1")).toHaveText("Fee ledger");
    await expect(page.getByTestId("ledger-month")).toHaveText("March 2032");
    await expect(page.getByTestId("ledger-bounds")).toContainText("Mar 1, 2032 00:00 to Mar 31, 2032 23:59:59 UTC");

    const cells = (row: import("@playwright/test").Locator) => row.locator("td, th").allInnerTexts();
    const rows = page.getByTestId("ledger-rows").locator("tbody tr");
    await expect(rows).toHaveCount(3);
    expect(await cells(rows.nth(0))).toEqual(["2032-03-10", "Mama Ngozi African Market", `#${NUMBERS[0]}`, "Order", "$70.79", "$1.80", "$8.99", "$0.31", "$0.00", "$12.83", "$0.00", "$1.49"]);
    expect(await cells(rows.nth(2))).toEqual(["2032-03-12", "Mama Ngozi African Market", `#${NUMBERS[1]}`, "Refund", "-$10.30", "$0.00", "$0.00", "$0.00", "$0.00", "$0.00", "-$0.84", "-$0.84"]);

    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`platform-fee-ledger-${MONTH}.csv`);
    const lines = (await (await file.createReadStream()).toArray()).join("").trim().split("\r\n");
    const screen = [];
    for (let i = 0; i < 3; i++) screen.push(await cells(rows.nth(i)));
    const total = await cells(page.getByTestId("ledger-month-total"));
    const asCsv = (text: string) => text.replace("$", "").replace(",", "");
    expect(lines.slice(1, 4).map((line) => line.split(",").slice(1))).toEqual(
      screen.map(([date, store, order, kind, ...amounts]) => [date, store, order, kind, ...amounts.map(asCsv)]),
    );
    expect(lines.at(-1)!.split(",").slice(5)).toEqual(total.slice(2).map(asCsv));
  });
});
