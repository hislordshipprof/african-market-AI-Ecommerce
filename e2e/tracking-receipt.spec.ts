import { test, expect, type Page } from "@playwright/test";
import { storeUrl } from "./urls";
import { deleteBatchOrders, insertTrackingOrder } from "./order-fixture";

const base = storeUrl("mama-ngozi");
const HELD = 741_001;
const CHARGED = 741_002;
const RUN = Date.now();
// Order #1007 from the 2026-11-23 walkthrough: 6 × $6.99, store delivery $4.99, service fee $1.26.
const ORDER_1007 = {
  fulfillment: "store-delivery" as const,
  money: { subtotalCents: 4194, deliveryFeeCents: 499, serviceFeeCents: 126, totalAuthorizedCents: 5238 },
  line: { qtyOrdered: 6, unitPriceCents: 699 },
};

/** Each receipt money row as [label, amount]. */
async function receiptRows(page: Page): Promise<string[][]> {
  const receipt = page.locator("section", { has: page.getByRole("heading", { name: "Receipt" }) });
  await expect(receipt.locator(".flow-fee-total")).toBeVisible();
  return receipt.locator(".flow-fee").evaluateAll((rows) => rows.map((row) => [
    row.querySelector("div > span")?.textContent?.trim() ?? "",
    row.querySelector(".sf-price > [aria-label]")?.getAttribute("aria-label") ?? "",
  ]));
}

test.describe("tracking receipt adds up and names fulfilment in words (#741)", () => {
  // Serial: each worker runs afterAll, so a parallel worker would delete the other test's order mid-run.
  test.describe.configure({ mode: "serial" });
  test.afterAll(async () => {
    await deleteBatchOrders([HELD, CHARGED]);
  });

  test("a delivery order lists the delivery fee, sums to its total and shows the hold before capture", async ({ page }) => {
    const token = `e2e-741-held-${RUN}`;
    await insertTrackingOrder({ number: HELD, token, status: "ACCEPTED", ...ORDER_1007 });
    await page.goto(`${base}/order/${token}`);
    await expect(page.getByRole("region", { name: "Accepted" })).toContainText(/Fulfillment:?\s*Store delivery/);
    expect(await receiptRows(page)).toEqual([
      ["Subtotal", "$41.94"],
      ["Store delivery", "$4.99"],
      ["Service fee", "$1.26"],
      ["Tax", "$0.00"],
      ["Total", "$48.19"],
      ["Authorization hold", "$52.38"],
    ]);
  });

  test("once captured the receipt shows what was charged, not the hold", async ({ page }) => {
    const token = `e2e-741-charged-${RUN}`;
    await insertTrackingOrder({
      number: CHARGED, token, status: "READY", capturedAmountCents: 4819,
      ...ORDER_1007, money: { ...ORDER_1007.money, captureCents: 4819 }, line: { ...ORDER_1007.line, qtyPicked: 6, status: "picked" },
    });
    await page.goto(`${base}/order/${token}`);
    await expect(page.getByRole("region", { name: "Ready for delivery" })).toContainText(/Fulfillment:?\s*Store delivery/);
    expect(await receiptRows(page)).toEqual([
      ["Subtotal", "$41.94"],
      ["Store delivery", "$4.99"],
      ["Service fee", "$1.26"],
      ["Tax", "$0.00"],
      ["Charged", "$48.19"],
    ]);
    await expect(page.getByText("Authorization hold")).toHaveCount(0);
  });
});
