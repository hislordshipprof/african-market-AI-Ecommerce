import { test, expect, type Page } from "@playwright/test";
import { generateTOTP } from "./totp";
import { deleteInboxOrder, insertInboxOrder, seedCaptureLabel, setInboxOrderStatus } from "./order-fixture";

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

  test("orders page renders header and seeded order cards with item counts", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    await expect(page.locator("h1", { hasText: "Orders" })).toBeVisible();
    await expect(page.locator("text=#1001")).toBeVisible();
    await expect(page.locator("text=Adaeze Chukwu").first()).toBeVisible();

    const firstCard = page.locator("button", { hasText: "#1001" });
    await expect(firstCard.locator("text=/\\d+ items?/")).toBeVisible();
    const itemText = await firstCard.locator("text=/\\d+ items?/").textContent();
    const count = parseInt(itemText?.match(/(\d+)/)?.[1] ?? "0", 10);
    expect(count).toBeGreaterThan(0);
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

    const orderCard = page.locator("button", { hasText: "#1003" });
    await expect(orderCard).toBeVisible();
    await orderCard.click();
    await expect(page.locator("text=Pick list")).toBeVisible();
    await expect(page.getByRole("button", { name: "Pick" }).first()).toBeVisible({ timeout: 10000 });
  });

  test("picking every line marks the order ready and captures the seed total", async ({ page }, testInfo) => {
    const number = 18680 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({ number, status: "PICKING", capturedAmountCents: null, seedHold: true });
    try {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    const orderCard = page.locator("button", { hasText: `#${number}` });
    await expect(orderCard).toBeVisible();
    await orderCard.click();
    await expect(page.locator("text=Pick list")).toBeVisible();

    const markReadyBtn = page.getByRole("button", { name: "Mark ready" });
    await expect(markReadyBtn).toBeVisible({ timeout: 10000 });
    await expect(markReadyBtn).toBeDisabled();

    const pickButtons = page.getByRole("button", { name: "Pick" });
    let remaining = await pickButtons.count();
    while (remaining > 0) {
      await pickButtons.first().click();
      remaining -= 1;
      await expect(pickButtons).toHaveCount(remaining);
    }

    await expect(markReadyBtn).toBeEnabled({ timeout: 10000 });
    await expect(page.getByTestId("order-captured")).toHaveCount(0);

    await markReadyBtn.click();

    await expect(page.locator("text=Order marked ready")).toBeVisible({ timeout: 15000 });

    const awaitingBadge = page.locator("text=Awaiting pickup");
    await expect(awaitingBadge).toBeVisible({ timeout: 15000 });

    const handOffBtn = page.getByRole("button", { name: "Hand off" });
    await expect(handOffBtn).toBeVisible({ timeout: 10000 });

    const seedTotal = await seedCaptureLabel(number);
    await expect(page.getByTestId("order-captured")).toHaveText(seedTotal);
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("the Captured line appears only after the order is ready", async ({ page }) => {
    const number = 18601;
    await insertInboxOrder({ number, status: "PICKING", capturedAmountCents: 2500 });
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.locator(`text=Order #${number}`)).toBeVisible();
      await expect(page.getByTestId("order-captured")).toHaveCount(0);

      await setInboxOrderStatus(number, "AWAITING_PICKUP");
      await page.reload();
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.getByTestId("order-captured")).toHaveText("$25.00");
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("a refund-failed order tells staff the platform is resolving it", async ({ page }) => {
    const number = 18602;
    await insertInboxOrder({ number, status: "REFUND_FAILED", capturedAmountCents: 1800 });
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.getByText("The platform team is resolving this refund. Do not refund the customer yourself.")).toBeVisible();
      await expect(page.getByTestId("order-captured")).toHaveText("$18.00");
      await expect(page.getByText("refund them another way")).toHaveCount(0);
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("a resolved cancellation stays in the inbox with the platform note", async ({ page }, testInfo) => {
    const number = 18691 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({
      number,
      status: "CANCELLED",
      capturedAmountCents: 2500,
      notes: "Paid customer by Zelle 11/05",
    });
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
      await expect(page.getByText("Paid customer by Zelle 11/05")).toBeVisible();
      await expect(page.getByText("The platform resolved this refund.")).toBeVisible();
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("no horizontal overflow at 390px mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);
    await expect(page.getByRole("heading", { name: /orders/i })).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
  });
});
