import { test, expect } from "@playwright/test";

test.describe("Store admin sign-in page", () => {
  test("renders sign-in form with story surface", async ({ page }) => {
    await page.goto("/store-admin/sign-in?store=mama-ngozi");

    await expect(page.locator("text=Store Admin")).toBeVisible();
    await expect(page.locator("text=Sign in to manage your store")).toBeVisible();
    await expect(page.locator("input[type='email']")).toBeVisible();
    await expect(page.locator("input[type='password']")).toBeVisible();
    await expect(page.locator("button[type='submit']")).toHaveText("Sign in");
  });

  test("story surface poster gradient covers viewport", async ({ page }) => {
    await page.goto("/store-admin/sign-in?store=mama-ngozi");

    const poster = page.locator("main > div[aria-hidden='true']").first();
    await expect(poster).toBeVisible();
    const box = await poster.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.height).toBeGreaterThanOrEqual(600);
  });

  test("form card has readable text on story surface", async ({ page }) => {
    await page.goto("/store-admin/sign-in?store=mama-ngozi");

    const card = page.locator("[class*='card']").first();
    await expect(card).toBeVisible();

    const bgColor = await card.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bgColor).toBeTruthy();
    expect(bgColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("card is at least 300px wide at desktop viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/store-admin/sign-in?store=mama-ngozi");

    const card = page.locator("[class*='card']").first();
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThanOrEqual(300);
  });

  test("no horizontal overflow at 320px mobile", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/store-admin/sign-in?store=mama-ngozi");

    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(320);
  });
});

test.describe("Invite accept page", () => {
  test("shows error card for invalid token", async ({ page }) => {
    await page.goto("/invite/invalid-token-abc123");

    await expect(page.getByText("Invalid Invitation", { exact: true })).toBeVisible();
    await expect(page.getByText("Invalid invitation link")).toBeVisible();
  });

  test("error card has story surface background", async ({ page }) => {
    await page.goto("/invite/invalid-token-abc123");

    const poster = page.locator("main > div[aria-hidden='true']").first();
    await expect(poster).toBeVisible();
  });
});
