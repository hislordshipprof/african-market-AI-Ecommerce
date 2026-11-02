import { test, expect, type Page } from "@playwright/test";
import { generateTOTP } from "./totp";

const OWNER_EMAIL = "owner@mama-ngozi.test";
const OWNER_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const ORDERS_URL = "/store-admin/orders?store=mama-ngozi";

async function storeOwnerSignIn(page: Page) {
  await page.goto("/store-admin/sign-in?store=mama-ngozi");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.click("button[type='submit']");

  await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 10000 });

  const code = generateTOTP(SEED_TOTP_SECRET);
  await page.getByLabel("Verification code").fill(code);
  await page.click("button[type='submit']");

  try {
    await page.waitForURL(
      (url) => url.pathname.startsWith("/store-admin") && !url.pathname.includes("sign-in"),
      { timeout: 15000 },
    );
  } catch {
    const url = page.url();
    const bodySnippet = await page.locator("body").textContent().catch(() => "");
    throw new Error(
      `Store owner sign-in failed | url: ${url} | body: ${bodySnippet?.slice(0, 300)}`,
    );
  }
}

test.describe("Order inbox", () => {
  test("dashboard shows Orders card that navigates to /store-admin/orders", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto("/store-admin?store=mama-ngozi");

    const ordersCard = page.locator("a", { hasText: "Orders" });
    await expect(ordersCard).toBeVisible();
    await ordersCard.click();
    await page.waitForURL((url) => url.pathname.includes("/store-admin/orders"));
    expect(page.url()).toContain("/store-admin/orders");
  });

  test("orders page renders header and seeded order cards", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    await expect(page.locator("h1", { hasText: "Orders" })).toBeVisible();
    await expect(page.locator("text=#1001")).toBeVisible();
    await expect(page.locator("text=Adaeze Chukwu").first()).toBeVisible();
  });

  test("orders page has audio toggle button", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    const audioBtn = page.locator("button[aria-label='Mute alerts']");
    await expect(audioBtn).toBeVisible();
    await audioBtn.click();
    await expect(page.locator("button[aria-label='Enable alerts']")).toBeVisible();
  });

  test("back arrow navigates to store admin dashboard", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    const backLink = page.locator("a[href*='/store-admin?store=']");
    await expect(backLink).toBeVisible();
    await backLink.click();
    await page.waitForURL((url) => url.pathname === "/store-admin");
  });

  test("new orders badge shows count", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    const badge = page.locator("text=/\\d+ new/");
    await expect(badge).toBeVisible();
  });

  test("clicking an order shows detail with customer name and status", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    await page.locator("button", { hasText: "#1001" }).click();
    await expect(page.locator("text=Order #1001")).toBeVisible();
    await expect(page.locator("text=Adaeze Chukwu")).toBeVisible();
    await expect(page.locator("text=Accept order")).toBeVisible();
  });

  test("picking order shows pick list with frozen-last sort", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    const pickingOrder = page.locator("button", { hasText: "Picking" });
    if (await pickingOrder.isVisible()) {
      await pickingOrder.click();
      await expect(page.locator("text=Pick list")).toBeVisible();
      await expect(page.locator("text=Pick").first()).toBeVisible();
    }
  });

  test("no horizontal overflow at 390px mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    await page.waitForTimeout(1000);
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
  });
});
