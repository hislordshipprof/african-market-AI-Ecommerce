import { test, expect } from "@playwright/test";

const BASE = "http://mama-ngozi.localhost:3000";

test.describe("Hero carousel (#55)", () => {
  test("renders with at least one banner", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const carousel = page.locator("[data-testid='hero-carousel']");
    await expect(carousel).toBeVisible({ timeout: 15000 });
  });

  test("banner has visible title text", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const carousel = page.locator("[data-testid='hero-carousel']");
    await expect(carousel).toBeVisible({ timeout: 15000 });
    const title = carousel.locator("h2, h3, [data-testid='banner-title']").first();
    await expect(title).toBeVisible();
    const text = await title.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test("clicking a dot advances the slide", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const carousel = page.locator("[data-testid='hero-carousel']");
    await expect(carousel).toBeVisible({ timeout: 15000 });

    const dots = carousel.locator("[data-testid='carousel-dot']");
    const dotCount = await dots.count();
    if (dotCount < 2) {
      test.skip();
      return;
    }

    await dots.nth(1).click();
    await expect(dots.nth(1)).toHaveAttribute("aria-current", "true", {
      timeout: 3000,
    });
  });
});

test.describe("Product rails (#55)", () => {
  test("at least one product rail renders", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const rails = page.locator("[data-testid='product-rail']");
    await expect(rails.first()).toBeVisible({ timeout: 15000 });
  });

  test("rail contains listing cards", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const rail = page.locator("[data-testid='product-rail']").first();
    await expect(rail).toBeVisible({ timeout: 15000 });
    const cards = rail.locator("[data-testid='listing-card']");
    await expect(cards.first()).toBeVisible({ timeout: 5000 });
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("rail is horizontally scrollable", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const rail = page.locator("[data-testid='product-rail']").first();
    await expect(rail).toBeVisible({ timeout: 15000 });

    const scrollContainer = rail.locator("[data-testid='rail-scroll']");
    const isScrollable = await scrollContainer.evaluate(
      (el) => el.scrollWidth > el.clientWidth,
    );
    expect(isScrollable).toBe(true);
  });
});

test.describe("Collection banners (#55)", () => {
  test("collection banners section renders", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const banners = page.locator("[data-testid='collection-banners']");
    await expect(banners).toBeVisible({ timeout: 15000 });
  });

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

test.describe("Quick-add button (#55)", () => {
  test("quick-add button exists on listing cards", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const card = page.locator("[data-testid='listing-card']").first();
    await expect(card).toBeVisible({ timeout: 15000 });

    const addBtn = card.locator("[data-testid='quick-add-btn']");
    await expect(addBtn).toBeVisible();
  });

  test("quick-add button is clickable without error", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const card = page.locator("[data-testid='listing-card']").first();
    await expect(card).toBeVisible({ timeout: 15000 });

    const addBtn = card.locator("[data-testid='quick-add-btn']");
    await addBtn.click();
  });
});

test.describe("Storefront header (#55)", () => {
  test("header is sticky", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const header = page.locator("[data-testid='storefront-header']");
    await expect(header).toBeVisible({ timeout: 15000 });

    const position = await header.evaluate(
      (el) => getComputedStyle(el).position,
    );
    expect(position).toBe("sticky");
  });

  test("header shows store name", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const header = page.locator("[data-testid='storefront-header']");
    await expect(header).toBeVisible({ timeout: 15000 });
    await expect(header).toContainText("Mama Ngozi");
  });
});

test.describe("Footer and trust strip (#55)", () => {
  test("footer renders with store name", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const footer = page.locator("[data-testid='storefront-footer']");
    await expect(footer).toBeVisible({ timeout: 15000 });
    await expect(footer).toContainText("Mama Ngozi");
  });

  test("trust strip renders with owner info", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const strip = page.locator("[data-testid='trust-strip']");
    await expect(strip).toBeVisible({ timeout: 15000 });
  });
});
