import { test, expect } from "@playwright/test";

const BASE = "http://localhost:3000";
const storeHeader = (page: import("@playwright/test").Page) =>
  page.locator("header h1, [data-testid='store-name']").first();

test.describe("Store override navigation (#56)", () => {
  test("navigating after ?store= landing retains store context", async ({
    page,
    context,
  }) => {
    await page.goto(`${BASE}/?store=mama-ngozi`);
    await expect(storeHeader(page)).toHaveText("Mama Ngozi African Market", {
      timeout: 15000,
    });

    const cookies = await context.cookies(BASE);
    const storeOverride = cookies.find((c) => c.name === "store_override");
    expect(storeOverride).toBeDefined();
    expect(storeOverride!.value).toBe("mama-ngozi");

    const categoryLink = page.locator("a[href^='/categories/']").first();
    await expect(categoryLink).toBeVisible({ timeout: 10000 });
    await categoryLink.click();
    await page.waitForURL(/\/categories\//);
    await expect(storeHeader(page)).toHaveText("Mama Ngozi African Market", {
      timeout: 10000,
    });

    const productCard = page.locator("[data-testid='listing-card']").first();
    await expect(productCard).toBeVisible({ timeout: 10000 });
    await productCard.click();
    await page.waitForURL(/\/listings\//);
    await expect(storeHeader(page)).toHaveText("Mama Ngozi African Market", {
      timeout: 10000,
    });

    const searchInput = page.locator("#storefront-search");
    await searchInput.fill("ugu");
    await searchInput.press("Enter");
    await page.waitForURL(/\/search\?q=/);
    await expect(page.locator("h2").first()).toContainText("Results for", {
      timeout: 10000,
    });
    await expect(storeHeader(page)).toHaveText("Mama Ngozi African Market");

    await page.locator("h1 a, a:has(h1)").first().click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect(storeHeader(page)).toHaveText("Mama Ngozi African Market", {
      timeout: 10000,
    });
  });

  test("switching ?store= replaces the active store", async ({ page }) => {
    await page.goto(`${BASE}/?store=mama-ngozi`);
    await expect(storeHeader(page)).toHaveText("Mama Ngozi African Market", {
      timeout: 15000,
    });

    await page.goto(`${BASE}/?store=tante-marie`);
    await expect(storeHeader(page)).toHaveText(
      "Tante Marie Caribbean Grocer",
      { timeout: 15000 },
    );

    await page.locator("a[href^='/categories/']").first().click();
    await page.waitForURL(/\/categories\//);
    await expect(storeHeader(page)).toHaveText(
      "Tante Marie Caribbean Grocer",
      { timeout: 10000 },
    );
  });
});
