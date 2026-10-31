import { test, expect } from "@playwright/test";

const BASE = "http://mama-ngozi.localhost:3000";

test.describe("Storefront browse and search (#8 acceptance criteria)", () => {
  test("category page lists active listings and excludes inactive ones", async ({
    page,
  }) => {
    await page.goto(`${BASE}/categories/grains-and-flours`);
    await expect(page.locator("h2").first()).toHaveText("Grains & Flours");

    await expect(page.locator("[data-testid='listing-card']").first()).toBeVisible({
      timeout: 10000,
    });
    const cards = page.locator("[data-testid='listing-card']");
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(3);

    const allText = await page.locator("main").textContent();
    expect(allText).not.toContain("Seasonal - Unavailable");
  });

  test("searching a synonym (ugu) finds the linked listing", async ({
    page,
  }) => {
    await page.goto(`${BASE}/search?q=ugu`);

    await expect(page.locator("h2").first()).toContainText("Results for");
    const results = page.locator("ul li a");
    await expect(results.first()).toBeVisible({ timeout: 10000 });

    const resultText = await page.locator("ul").first().textContent();
    expect(resultText?.toLowerCase()).toContain("ugu");
  });

  test("product page shows variant prices and stock badge", async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toBeVisible({ timeout: 10000 });

    const firstCard = page.locator("[data-testid='listing-card']").first();
    await expect(firstCard).toBeVisible({ timeout: 10000 });
    await firstCard.click();

    await page.waitForURL(/\/listings\//);

    const variantSection = page.locator("#variants-heading");
    await expect(variantSection).toBeVisible({ timeout: 5000 });

    const variantRows = page.locator("[aria-labelledby='variants-heading'] li");
    const variantCount = await variantRows.count();
    expect(variantCount).toBeGreaterThanOrEqual(1);

    const pricePattern = /\$\d+/;
    const firstVariantText = await variantRows.first().textContent();
    expect(firstVariantText).toMatch(pricePattern);

    const badge = page.locator("[data-testid='stock-badge']");
    await expect(badge).toBeVisible();
  });

  test("home page shows seeded listings", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toBeVisible({ timeout: 10000 });

    const listingsSection = page.locator("#listings-heading");
    await expect(listingsSection).toBeVisible({ timeout: 10000 });

    const cards = page.locator("[data-testid='listing-card']");
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test("searching ogbono finds wild mango seed", async ({ page }) => {
    await page.goto(`${BASE}/search?q=ogbono`);

    const results = page.locator("ul li a");
    await expect(results.first()).toBeVisible({ timeout: 10000 });

    const resultText = await page.locator("ul").first().textContent();
    expect(
      resultText?.toLowerCase().includes("ogbono") ||
        resultText?.toLowerCase().includes("wild mango"),
    ).toBe(true);
  });
});
