import { storeUrl } from "./urls";
import { test, expect } from "@playwright/test";

const BASE = storeUrl("mama-ngozi");

test.describe("Collection banners", () => {
  test("collection cards link to /collections/ paths", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const banners = page.locator("[data-testid='collection-banners']");
    await expect(banners).toBeVisible({ timeout: 15000 });

    const links = banners.locator("a[href*='/collections/']");
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(1);

    const href = await links.first().getAttribute("href");
    expect(href).toMatch(/\/collections\/.+/);
  });
});

test.describe("Quick-add button", () => {
  test("clicking quick-add shows stepper with quantity 1", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const card = page.locator("[data-testid='listing-card']").first();
    await expect(card).toBeVisible({ timeout: 15000 });

    const addBtn = card.locator("[data-testid='quick-add-btn']");
    await addBtn.click();

    const stepper = card.locator("[data-testid='quick-add-stepper']");
    await expect(stepper).toBeVisible({ timeout: 3000 });

    const qty = card.locator("[data-testid='stepper-qty']");
    await expect(qty).toHaveText("1");
  });

  test("stepper minus returns to add button at zero", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const card = page.locator("[data-testid='listing-card']").first();
    await expect(card).toBeVisible({ timeout: 15000 });

    const addBtn = card.locator("[data-testid='quick-add-btn']");
    await addBtn.click();

    const minus = card.locator("[data-testid='stepper-minus']");
    await expect(minus).toBeVisible({ timeout: 3000 });
    await minus.click();

    await expect(card.locator("[data-testid='quick-add-btn']")).toBeVisible({
      timeout: 3000,
    });
  });
});
