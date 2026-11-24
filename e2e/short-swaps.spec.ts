import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { deleteBatchOrders, insertShortSwapOrder } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";
import { storeUrl } from "./urls";

const base = storeUrl("mama-ngozi");
const ORDERS_URL = "/store-admin/orders?store=mama-ngozi";
const ORDER_PAGE = 762_001;
const SWAP_PAGE = 762_002;
const PICK_LIST = 762_003;
const CAPTURED = 762_004;
const RUN = Date.now();
const PROOF = process.env.PROOF_DIR;

/** Screenshots for the review, only when PROOF_DIR is set: 390 and 1280, light and dark. */
async function shoot(page: Page, name: string) {
  if (!PROOF) return;
  mkdirSync(PROOF, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${PROOF}/${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.describe("short picks and swaps add up and never charge an unapproved pricier swap (#762)", () => {
  test.afterAll(async () => {
    await deleteBatchOrders([ORDER_PAGE, SWAP_PAGE, PICK_LIST, CAPTURED]);
  });

  test("the order page gives the deadline, and the receipt names the swap and shows the expected total", async ({ page }) => {
    const token = `e2e-762-order-${RUN}`;
    // 21:35 UTC is 3:35 PM in Houston.
    const { swapName } = await insertShortSwapOrder({ number: ORDER_PAGE, token, expiresAt: new Date("2027-01-05T21:35:00Z") });
    await page.goto(`${base}/order/${token}`);
    await expect(page.getByText(/Choose a swap or a refund by 3:35 PM CST/)).toBeVisible();
    const receipt = page.locator(".flow-card", { has: page.getByRole("heading", { name: "Receipt" }) });
    await expect(receipt.getByText(`Swapped for ${swapName}`, { exact: false })).toBeVisible();
    await expect(receipt.getByText("0 of 1 found")).toBeVisible();
    // Goods now 12.99 + 5.99 + 10.99 + 3.49 = 33.46, fee 3% = 1.00.
    await expect(receipt).toContainText("Expected total");
    await expect(receipt).toContainText("$34.46");
    await shoot(page, "order-page-pending");
  });

  test("the swap page says a pricier swap is refunded on timeout, and an answered card keeps its item name", async ({ page }) => {
    const token = `e2e-762-swaps-${RUN}`;
    const { pendingName, swapName } = await insertShortSwapOrder({ number: SWAP_PAGE, token });
    await page.goto(`${base}/order/${token}/substitutions`);
    const pending = page.locator(".flow-card", { hasText: `${pendingName} is short` });
    await expect(pending).toContainText("we’ll refund this item, as the swap costs more");
    await expect(page.locator(".flow-card", { hasText: "answered" }).first()).toContainText(": answered");
    await expect(page.getByText(`Swapped for ${swapName}.`)).toBeVisible();
    await shoot(page, "swap-page");
  });

  test("the pick list shows each line's swap choice before Short, and the breakdown adds up to the expected total", async ({ page }) => {
    const { substituteName } = await insertShortSwapOrder({ number: PICK_LIST, token: `e2e-762-pick-${RUN}` });
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);
    await page.locator("button", { hasText: `#${PICK_LIST}` }).click();
    await expect(page.getByTestId("pick-line-swap-choice")).toHaveText(`If short: swap for ${substituteName}`);
    await expect(page.getByTestId("order-subtotal")).toHaveText("$33.46");
    await expect(page.getByTestId("order-service-fee")).toHaveText("$1.00");
    await expect(page.getByTestId("order-total")).toHaveText("$34.46");
    await expect(page.getByText("Expected total")).toBeVisible();
    await shoot(page, "staff-pick-list");
  });

  test("after capture the staff breakdown adds up to what was captured (#1006)", async ({ page }) => {
    await insertShortSwapOrder({ number: CAPTURED, token: `e2e-762-captured-${RUN}`, captured: true });
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);
    await page.locator("button", { hasText: `#${CAPTURED}` }).click();
    // 12.99 + 5.99 = 18.98 of goods, the $0.99 minimum fee: 19.97 captured.
    await expect(page.getByTestId("order-subtotal")).toHaveText("$18.98");
    await expect(page.getByTestId("order-service-fee")).toHaveText("$0.99");
    await expect(page.getByTestId("order-total")).toHaveText("$19.97");
    await expect(page.getByTestId("order-captured")).toHaveText("$19.97");
    await shoot(page, "staff-captured");
  });
});
