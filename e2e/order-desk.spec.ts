import { test, expect, type Page } from "@playwright/test";
import { deleteBatchOrders, insertBatchOrders, setOrderReadyEstimate } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";

const DASHBOARD_URL = "/store-admin?store=mama-ngozi";
const ORDERS_URL = "/store-admin/orders?store=mama-ngozi";
/** Server actions POST to the page they run on; aborting them is the "refresh failed" fixture. */
const INBOX = (url: URL) => url.pathname === "/store-admin/orders";
const PACKING = (url: URL) => url.pathname.startsWith("/store-admin/orders/batch/");
const failActions = (page: Page, path: (url: URL) => boolean) =>
  page.route(path, (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));

/** Puts two accepted orders in one batch from the inbox and opens its packing screen. */
async function openBatch(page: Page, [older, newer]: number[]) {
  await page.goto(ORDERS_URL);
  const card = page.getByRole("group").filter({ hasText: "Choose 2 to 4 accepted orders" });
  await card.getByRole("checkbox", { name: new RegExp(`#${older}\\b`) }).check();
  await card.getByRole("checkbox", { name: new RegExp(`#${newer}\\b`) }).check();
  await page.getByRole("button", { name: "Pick 2 orders together" }).click();
  await page.waitForURL(/\/store-admin\/orders\/batch\//);
}

test.describe("Order desk (#725)", () => {
  test("the dashboard's first daily links are Orders, Messages, Products", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(DASHBOARD_URL);
    const links = page.getByRole("main").getByRole("link");
    await expect(links.first()).toBeVisible();
    // Payment and plan warnings sit above the cards in alert/status boxes; the cards start after them.
    const cards = await links.evaluateAll((els) =>
      els.filter((el) => !el.closest("[role=alert],[role=status]")).map((el) => new URL((el as HTMLAnchorElement).href).pathname),
    );
    expect(cards.slice(0, 3)).toEqual(["/store-admin/orders", "/store-admin/messages", "/store-admin/listings"]);
  });

  test("a failed inbox refresh keeps the orders and says Updates paused until the next good poll", async ({ page }) => {
    test.setTimeout(60_000);
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);
    const order = page.locator("button", { hasText: "#1001" });
    await expect(order).toBeVisible();

    await failActions(page, INBOX);
    const paused = page.getByRole("status").filter({ hasText: "Updates paused" });
    await expect(paused).toBeVisible({ timeout: 15_000 });
    await expect(paused).toContainText(/Last updated \d{1,2}:\d{2} [AP]M [A-Z]{2,4}/);
    await expect(order).toBeVisible();
    const retry = paused.getByRole("button", { name: "Retry" });
    expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await retry.click();
    await expect(paused).toBeVisible();

    await page.unroute(INBOX);
    await expect(paused).toHaveCount(0, { timeout: 15_000 });
    await expect(order).toBeVisible();
  });

  test("a failed packing refresh keeps the batch, and Retry clears Updates paused", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const base = 72520 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex * 2;
    await insertBatchOrders([base, base + 1], ["pickup", "pickup"]);
    try {
      await storeOwnerSignIn(page);
      await openBatch(page, [base, base + 1]);
      const totes = page.getByTestId("tote");
      await expect(totes).toHaveCount(2);

      await failActions(page, PACKING);
      const paused = page.getByRole("status").filter({ hasText: "Updates paused" });
      await expect(paused).toBeVisible({ timeout: 15_000 });
      await expect(paused).toContainText(/Last updated \d{1,2}:\d{2} [AP]M [A-Z]{2,4}/);
      await expect(totes).toHaveCount(2);
      const retry = paused.getByRole("button", { name: "Retry" });
      expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);

      await page.unroute(PACKING);
      await retry.click();
      await expect(paused).toHaveCount(0);
      await expect(totes).toHaveCount(2);
    } finally {
      await deleteBatchOrders([base, base + 1]);
    }
  });

  test.describe("in a browser away from the store's zone", () => {
    test.use({ timezoneId: "Pacific/Honolulu" });

    test("packing ready times show in the store's zone, labelled", async ({ page }, testInfo) => {
      const base = 72560 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex * 2;
      await insertBatchOrders([base, base + 1], ["courier", "pickup"]);
      try {
        await storeOwnerSignIn(page);
        await openBatch(page, [base, base + 1]);
        // mama-ngozi is in America/Chicago: 21:05 UTC on Nov 23 is 3:05 PM CST (11:05 AM in Honolulu).
        await setOrderReadyEstimate(base, new Date("2026-11-23T21:05:00Z"));
        await page.reload();
        await expect(page.getByTestId("tote").first()).toContainText("Ready by 3:05 PM CST");
      } finally {
        await deleteBatchOrders([base, base + 1]);
      }
    });
  });
});
