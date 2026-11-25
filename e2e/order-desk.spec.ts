import { test, expect, type Page } from "@playwright/test";
import { deleteBatchOrders, deleteInboxOrder, insertBatchOrders, insertInboxOrder, setInboxOrderStatus, setOrderReadyEstimate } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";

const DASHBOARD_URL = "/store-admin?store=mama-ngozi";
const ORDERS_URL = "/store-admin/orders?store=mama-ngozi";
/** Server actions POST to the page they run on; aborting them is the "refresh failed" fixture. */
const INBOX = (url: URL) => url.pathname === "/store-admin/orders";
const PACKING = (url: URL) => url.pathname.startsWith("/store-admin/orders/batch/");
const failActions = (page: Page, path: (url: URL) => boolean) =>
  page.route(path, (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));

/** Fails every server action that carries arguments (a staff action) and lets the argument-less inbox poll through. */
const failStaffActions = (page: Page) =>
  page.route(
    (url) => url.pathname.startsWith("/store-admin/orders"),
    (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.continue();
      let args: unknown = null;
      try {
        args = JSON.parse(request.postData() ?? "null");
      } catch {}
      // The polls send [] (inbox) or [batchId] (packing); staff actions send more.
      return Array.isArray(args) && args.length > (new URL(request.url()).pathname === "/store-admin/orders" ? 0 : 1) ? route.abort() : route.continue();
    },
  );

/** Layout height, so an opening dialog's scale-in does not shrink the reading. */
const height = (locator: import("@playwright/test").Locator) => locator.evaluate((el) => (el as HTMLElement).offsetHeight);

/** Contrast of an element's text against the colour actually painted behind it (translucent layers blended). */
const textContrast = (locator: import("@playwright/test").Locator) =>
  locator.evaluate((el) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgba = (css: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const layers: number[][] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const bg = rgba(getComputedStyle(node).backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] === 1) break;
    }
    let base = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
    const fg = rgba(getComputedStyle(el).color);
    const lum = ([r, g, b]: number[]) => {
      const c = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const [hi, lo] = [lum(fg), lum(base)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  });

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
  test("Home's first action is Open orders, and the sidebar leads with Home, then Orders and Products (#725, #860)", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(DASHBOARD_URL);
    const main = page.getByRole("main");
    await expect(main.getByRole("link", { name: "Open orders" })).toHaveAttribute("href", /\/store-admin\/orders\?/);
    const sidebar = page.getByRole("complementary", { name: "Store admin" }).getByRole("link");
    const paths = await sidebar.evaluateAll((els) => els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
    expect(paths.slice(0, 3)).toEqual(["/store-admin", "/store-admin/orders", "/store-admin/listings"]);
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
    expect(await height(retry)).toBeGreaterThanOrEqual(44);
    await retry.click();
    await expect(paused).toBeVisible();

    await page.unroute(INBOX);
    await expect(paused).toHaveCount(0, { timeout: 15_000 });
    await expect(order).toBeVisible();
  });

  test("a failed packing refresh keeps the batch, and Retry clears Updates paused", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const base = 72500 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex * 2;
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
      expect(await height(retry)).toBeGreaterThanOrEqual(44);

      await page.unroute(PACKING);
      await retry.click();
      await expect(paused).toHaveCount(0);
      await expect(totes).toHaveCount(2);
    } finally {
      await deleteBatchOrders([base, base + 1]);
    }
  });

  test("order desk controls are thumb-sized at 390px and the product name wraps instead of truncating", async ({ page }, testInfo) => {
    const number = 72600 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({ number, status: "PICKING", capturedAmountCents: null });
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);

      const menu = page.getByRole("button", { name: "Open menu" });
      expect(await height(menu)).toBeGreaterThanOrEqual(44);

      await page.locator("button", { hasText: "#1001" }).click();
      expect(await height(page.getByRole("button", { name: "Accept order" }))).toBeGreaterThanOrEqual(48);
      const backToOrders = page.getByRole("button", { name: "Back to orders" });
      expect(await height(backToOrders)).toBeGreaterThanOrEqual(44);
      await backToOrders.click();

      await page.locator("button", { hasText: `#${number}` }).click();
      expect(await height(page.getByRole("button", { name: "Mark ready" }))).toBeGreaterThanOrEqual(48);
      const row = page.getByTestId("pick-line").first();
      for (const name of ["Short", "Pick"]) {
        expect(await height(row.getByRole("button", { name, exact: true }))).toBeGreaterThanOrEqual(44);
      }
      const productName = row.getByTestId("pick-line-name");
      expect(await productName.evaluate((el) => el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== "ellipsis")).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("a failed pick shows its error on that line, and a picked line stays readable in dark mode", async ({ page }, testInfo) => {
    const number = 72700 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({ number, status: "PICKING", capturedAmountCents: null });
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${number}` }).click();
      const row = page.getByTestId("pick-line").first();

      await failStaffActions(page);
      await row.getByRole("button", { name: "Pick", exact: true }).click();
      await expect(row.getByRole("alert")).toContainText(/\w/);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

      await page.unrouteAll({ behavior: "wait" });
      await row.getByRole("button", { name: "Pick", exact: true }).click();
      await expect(page.locator("[data-sonner-toast]", { hasText: "Line picked" })).toBeVisible();
      await expect(row.getByRole("alert")).toHaveCount(0);

      await page.emulateMedia({ colorScheme: "dark" });
      // The row's colours transition when the scheme flips, so wait for them to settle.
      await expect.poll(() => textContrast(row.getByTestId("pick-line-name"))).toBeGreaterThanOrEqual(4.5);
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("a failed Pick together shows its error under the button, and the dialog's Accept is 48px", async ({ page }, testInfo) => {
    const base = 72400 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex * 2;
    await insertBatchOrders([base, base + 1], ["pickup", "pickup"]);
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      const card = page.getByRole("group").filter({ hasText: "Choose 2 to 4 accepted orders" });
      await card.getByRole("checkbox", { name: new RegExp(`#${base}\\b`) }).check();
      await card.getByRole("checkbox", { name: new RegExp(`#${base + 1}\\b`) }).check();
      await failStaffActions(page);
      await page.getByRole("button", { name: "Pick 2 orders together" }).click();
      await expect(card.getByRole("alert")).toContainText(/\w/);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      await page.unrouteAll({ behavior: "wait" });

      await page.locator("button", { hasText: "#1001" }).click();
      await page.getByRole("button", { name: "Accept order" }).click();
      const dialog = page.getByRole("dialog", { name: "Accept order" });
      expect(await height(dialog.getByRole("button", { name: "Accept", exact: true }))).toBeGreaterThanOrEqual(48);
      expect(await height(dialog.getByRole("button", { name: "Cancel", exact: true }))).toBeGreaterThanOrEqual(44);
    } finally {
      await deleteBatchOrders([base, base + 1]);
    }
  });

  test("a failed packing action shows its error on that line", async ({ page }, testInfo) => {
    const base = 72800 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex * 2;
    await insertBatchOrders([base, base + 1], ["pickup", "pickup"]);
    try {
      await storeOwnerSignIn(page);
      await openBatch(page, [base, base + 1]);
      await page.getByRole("button", { name: "Start packing" }).click();
      const line = page.getByTestId("batch-line").first();
      await expect(line.getByRole("button", { name: /^Picked all/ })).toBeEnabled();

      await failStaffActions(page);
      await line.getByRole("button", { name: /^Picked all/ }).click();
      await expect(line.getByRole("alert")).toContainText(/\w/);
      await expect(page.locator("[data-sonner-toast]", { hasText: /went wrong|try again/i })).toHaveCount(0);
    } finally {
      await deleteBatchOrders([base, base + 1]);
    }
  });

  test.describe("in a browser away from the store's zone", () => {
    test.use({ timezoneId: "Pacific/Honolulu" });

    test("packing ready times show in the store's zone, labelled, on the packing screen and in the inbox", async ({ page }, testInfo) => {
      const base = 72900 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex * 2;
      await insertBatchOrders([base, base + 1], ["courier", "pickup"]);
      try {
        await storeOwnerSignIn(page);
        await openBatch(page, [base, base + 1]);
        // mama-ngozi is in America/Chicago: 21:05 UTC on Nov 23 is 3:05 PM CST (11:05 AM in Honolulu).
        await setOrderReadyEstimate(base, new Date("2026-11-23T21:05:00Z"));
        await page.reload();
        await expect(page.getByTestId("tote").first()).toContainText("Ready by 3:05 PM CST");
        // The inbox's Courier timing for the same order, once PICKING, shows the same labelled time.
        await setInboxOrderStatus(base, "PICKING");
        await page.goto(ORDERS_URL);
        await page.locator("button", { hasText: `#${base}` }).click();
        await expect(page.getByLabel("Courier timing")).toContainText("Ready by 3:05 PM CST");
      } finally {
        await deleteBatchOrders([base, base + 1]);
      }
    });
  });
});
