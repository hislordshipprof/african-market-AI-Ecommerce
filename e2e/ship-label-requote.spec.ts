import { test, expect, type Page } from "@playwright/test";
import { deleteShipRequoteOrder, insertShipRequoteOrder, shipRequoteOrder } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";

const ORDERS_URL = "/store-admin/orders?store=mama-ngozi";

/** Opens the order and asks for its label, which Shippo refuses and re-quotes. */
async function buyLabel(page: Page, number: number) {
  await page.goto(ORDERS_URL);
  await page.locator("button", { hasText: `#${number}` }).click();
  await page.getByRole("button", { name: "Buy label" }).click();
}

async function proof(page: Page, number: number, name: string, ready: () => Promise<void>) {
  const proofDir = process.env.PROOF_DIR;
  if (!proofDir) return;
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [390, 1280]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await buyLabel(page, number);
      await ready();
      await page.screenshot({ path: `${proofDir}/${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: null });
}

test.describe("A label refused after capture re-quotes (#771)", () => {
  test("within $5 staff confirm the fresh rate and the label is bought on it; the platform's $3.00 is recorded", async ({ page }) => {
    const number = 7711;
    await insertShipRequoteOrder(number, 625);
    try {
      await storeOwnerSignIn(page);
      const panel = page.getByRole("alert").filter({ hasText: "The rate for this label expired." });
      await proof(page, number, "ready-requote-confirm", () => expect(panel).toBeVisible());
      await buyLabel(page, number);
      await expect(panel).toContainText("The new rate is $9.25, $3.00 more than the shopper paid. The platform pays the difference. Confirm to buy the label");
      await panel.getByRole("button", { name: "Buy label at $9.25" }).click();
      // The e2e server cannot upload the PDF, so the sale stands and only the PDF is missing.
      await expect(page.getByText("The label is bought but its PDF could not be saved")).toBeVisible();
      const order = await shipRequoteOrder(number);
      expect(order).toMatchObject({ shippingLabelStatus: "bought", shippingPostageCents: 625, shippingLabelPostageCents: 925 });
      expect(order.shippingRateId).not.toBe(`rate_e2e_dead_${number}`);
    } finally {
      await deleteShipRequoteOrder(number);
    }
  });

  test("over $5 more staff are offered cancel and refund, not a purchase", async ({ page }) => {
    const number = 7712;
    await insertShipRequoteOrder(number, 300);
    try {
      await storeOwnerSignIn(page);
      const panel = page.getByRole("alert").filter({ hasText: "The rate for this label expired." });
      await proof(page, number, "ready-requote-cancel", () => expect(panel).toBeVisible());
      await buyLabel(page, number);
      await expect(panel).toContainText("The new rate is $9.25, $6.25 more than the shopper paid. That is over the $5.00 the platform covers, so cancel the shipment and refund the customer");
      await expect(page.getByRole("button", { name: /^Buy label/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Cancel shipment and refund" })).toBeVisible();
      expect(await shipRequoteOrder(number)).toMatchObject({ shippingLabelStatus: null, shippingLabelPostageCents: null });
    } finally {
      await deleteShipRequoteOrder(number);
    }
  });
});
