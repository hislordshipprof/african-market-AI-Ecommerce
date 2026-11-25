import { expect, test, type Page } from "@playwright/test";
import { deleteInboxOrder, inboxOrderId, inboxOrderStatus, insertInboxOrder, mamaOrderStatusCounts } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";

const STORE = "?store=mama-ngozi";
const OWNER_NAV = [
  ["Home", "/store-admin"],
  ["Orders", "/store-admin/orders"],
  ["Products", "/store-admin/listings"],
  ["Purchase orders", "/store-admin/purchase-orders"],
  ["Shipping", "/store-admin/shipping"],
  ["Messages", "/store-admin/messages"],
  ["Promotions", "/store-admin/promotions"],
  ["Directory listing", "/store-admin/directory"],
  ["WhatsApp", "/store-admin/whatsapp"],
  ["Payouts", "/store-admin/payouts"],
  ["Plan", "/store-admin/plan"],
  ["Team", "/store-admin/team"],
  ["Analytics", "/store-admin/analytics"],
  ["Settings", "/store-admin/settings"],
] as const;

function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "Store admin" });
}

/** Other workers add orders to the same store; read the store's counts until they hold still around the page load. */
async function steadyCounts(page: Page, url: string): Promise<Record<string, number>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await mamaOrderStatusCounts();
    await page.goto(url);
    await page.getByRole("main").waitFor();
    const after = await mamaOrderStatusCounts();
    if (JSON.stringify(before) === JSON.stringify(after)) return after;
  }
  throw new Error("the store's orders kept changing");
}

test.describe("Store admin shell (#860)", () => {
  test("the owner's sidebar groups every page, and each item opens its page", async ({ page }) => {
    test.setTimeout(120_000);
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin${STORE}`);
    const nav = sidebar(page).getByRole("navigation");
    for (const group of ["Sell", "Customers", "Marketing", "Money", "Store"]) {
      await expect(nav.getByText(group, { exact: true })).toBeVisible();
    }
    const labels = await nav.getByRole("link").evaluateAll((els) => els.map((el) => el.querySelector("span")?.textContent));
    expect(labels).toEqual(OWNER_NAV.map(([label]) => label));

    for (const [label, path] of OWNER_NAV) {
      await sidebar(page).getByRole("link", { name: new RegExp(`^${label}\\b`) }).click();
      await page.waitForURL((url) => url.pathname === path);
      await expect(page.locator("h1")).toBeVisible();
      await expect(sidebar(page).getByRole("link", { name: new RegExp(`^${label}\\b`) })).toHaveAttribute("aria-current", "page");
    }
    await expect(page.getByRole("link", { name: "Back to dashboard" })).toHaveCount(0);
  });

  test("on a phone the sidebar is a drawer opened from the top bar, with 44px targets", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin${STORE}`);
    await expect(sidebar(page)).toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Menu" });
    await expect(drawer).toBeVisible();
    for (const link of await drawer.getByRole("navigation").getByRole("link").all()) {
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await drawer.getByRole("link", { name: /^Orders\b/ }).click();
    await page.waitForURL((url) => url.pathname === "/store-admin/orders");
    await expect(drawer).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("Home shows the store's real counts, and each waiting job links to its page", async ({ page }, testInfo) => {
    const number = 86000 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({ number, status: "AUTHORIZED", capturedAmountCents: null });
    try {
      await storeOwnerSignIn(page);
      const counts = await steadyCounts(page, `/store-admin${STORE}`);
      const fresh = counts.AUTHORIZED ?? 0;
      const packing = (counts.ACCEPTED ?? 0) + (counts.PICKING ?? 0) + (counts.SUBSTITUTION_PENDING ?? 0);
      expect(fresh).toBeGreaterThan(0);

      await expect(page.getByTestId("stat-to-pack")).toContainText(String(fresh + packing));
      await expect(page.getByTestId("stat-to-pack")).toContainText(`${fresh} new, ${packing} packing`);
      const accept = page.getByTestId("needs-you-now").getByRole("link", { name: new RegExp(`^Accept ${fresh} new orders?`) });
      await expect(accept).toHaveAttribute("href", `/store-admin/orders${STORE}`);
      await expect(page.getByRole("link", { name: `Order alerts: ${fresh} new` })).toBeVisible();
      await expect(sidebar(page).getByRole("link", { name: `Orders ${fresh} new` })).toBeVisible();
      await expect(page.getByTestId("recent-orders")).toContainText(`#${number}`);
      await expect(page.getByTestId("week-chart").locator("li")).toHaveCount(7);

      await accept.click();
      await page.waitForURL((url) => url.pathname === "/store-admin/orders");
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("Orders: stage tabs count the orders, the panel opens beside the list and Accept works there", async ({ page }, testInfo) => {
    const number = 86400 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({ number, status: "AUTHORIZED", capturedAmountCents: null });
    try {
      await storeOwnerSignIn(page);
      const counts = await steadyCounts(page, `/store-admin/orders${STORE}`);
      const placed = page.getByRole("tab", { name: /^Order placed/ });
      await expect(placed).toHaveText(new RegExp(`^Order placed\\s*${counts.AUTHORIZED}$`));
      await placed.click();
      await expect(placed).toHaveAttribute("aria-selected", "true");
      const rows = page.getByRole("main").getByRole("listitem").filter({ has: page.locator("[data-testid=order-card-fulfillment]") });
      await expect(rows).toHaveCount(counts.AUTHORIZED);

      await page.getByLabel("Find an order by number or customer").fill(`#${number}`);
      await expect(rows).toHaveCount(1);
      await rows.first().getByRole("button").click();
      const panel = page.getByTestId("order-panel");
      await expect(panel.getByText(`Order #${number}`)).toBeVisible();
      // The list stays beside the panel at desktop width.
      await expect(rows.first()).toBeVisible();

      await panel.getByRole("button", { name: "Accept order" }).click();
      await page.getByRole("dialog", { name: "Accept order" }).getByRole("button", { name: "Accept", exact: true }).click();
      await expect(panel.getByText("Pick list")).toBeVisible();
      expect(await inboxOrderStatus(number)).not.toBe("AUTHORIZED");

      // The panel's own address opens it directly.
      await page.goto(`/store-admin/orders/${await inboxOrderId(number)}${STORE}`);
      await expect(page.getByTestId("order-panel").getByText(`Order #${number}`)).toBeVisible();
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("the assistant button never covers the order panel's actions", async ({ page }, testInfo) => {
    const number = 86800 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({ number, status: "AUTHORIZED", capturedAmountCents: null });
    try {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
        if (width === 1280) await storeOwnerSignIn(page);
        await page.goto(`/store-admin/orders/${await inboxOrderId(number)}${STORE}`);
        const launcher = page.getByTestId("assistant-launcher");
        await expect(launcher).toBeVisible();
        for (const name of ["Accept order", "Cancel order"]) {
          const action = page.getByTestId("order-panel").getByRole("button", { name });
          await expect(action).toBeInViewport();
          await expect.poll(async () => {
            const a = (await action.boundingBox())!;
            const l = (await launcher.boundingBox())!;
            return l.y + l.height <= a.y || l.x >= a.x + a.width || l.x + l.width <= a.x || l.y >= a.y + a.height;
          }).toBe(true);
        }
      }
    } finally {
      await deleteInboxOrder(number);
    }
  });
});
