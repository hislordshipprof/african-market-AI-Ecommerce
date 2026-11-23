import { test, expect, type Page } from "@playwright/test";
import { storeUrl } from "./urls";

const BASE = storeUrl("mama-ngozi");

async function cardPrices(page: Page) {
  const labels = await page.getByTestId("listing-card").locator(".sf-price > span[aria-label]").evaluateAll(
    (spans) => spans.map((s) => s.getAttribute("aria-label") ?? ""),
  );
  return labels.map((l) => Number(l.replace(/[^0-9.]/g, "")));
}

test.describe("Storefront discovery (#727)", () => {
  test("search keeps the query through a URL-backed Frozen filter and price sort, and Clear filters resets them", async ({ page }) => {
    await page.goto(`${BASE}/search?q=leaf`);
    const cards = page.getByTestId("listing-card");
    await expect(cards.first()).toBeVisible();
    const all = await cards.count();
    await expect(page.locator(".sf-result-count")).toContainText(/\d+ products?/);

    await page.getByTestId("filter-frozen").click();
    await expect(page).toHaveURL(/[?&]q=leaf/);
    await expect(page).toHaveURL(/[?&]frozen=1/);
    await expect(page.getByTestId("filter-frozen")).toHaveAttribute("aria-current", "page");
    await expect.poll(async () => {
      const n = await cards.count();
      const tags = await cards.locator(".sf-photo-tag").allTextContents();
      return n > 0 && n < all && tags.length === n && tags.every((t) => t === "Frozen");
    }).toBe(true);

    await page.getByLabel("Sort products").selectOption("price-high");
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    await expect(page).toHaveURL(/sort=price-high/);
    await expect(page).toHaveURL(/[?&]q=leaf/);
    await expect(page).toHaveURL(/[?&]frozen=1/);
    const high = await cardPrices(page);
    expect(high.length).toBeGreaterThan(1);
    expect(high).toEqual([...high].sort((a, b) => b - a));

    await page.getByLabel("Sort products").selectOption("price-low");
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    await expect(page).toHaveURL(/sort=price-low/);
    const low = await cardPrices(page);
    expect(low).toEqual([...low].sort((a, b) => a - b));

    await page.getByTestId("clear-filters").first().click();
    await expect(page).toHaveURL(/\/search\?q=leaf$/);
    await expect(cards).toHaveCount(all);
  });

  test("a search filter that leaves nothing offers Clear filters, not a failed search", async ({ page }) => {
    await page.goto(`${BASE}/search?q=egusi&frozen=1`);
    await expect(page.getByTestId("listing-card")).toHaveCount(0);
    await expect(page.getByText(/No results for/)).toHaveCount(0);
    await page.getByTestId("clear-filters").first().click();
    await expect(page).toHaveURL(/\/search\?q=egusi$/);
    await expect(page.getByTestId("listing-card").first()).toBeVisible();
  });

  test("a category page counts products, not listings", async ({ page }) => {
    await page.goto(`${BASE}/categories/vegetables`);
    await expect(page.locator(".sf-result-count")).toContainText(/\d+ products?/);
    await expect(page.locator(".sf-result-count")).not.toContainText("listing");
  });

  test("the product page shows the same-aisle rail as such and no unknown origin", async ({ page }) => {
    await page.goto(`${BASE}/listings/mn_egusi`);
    await expect(page.getByRole("heading", { name: "More from this aisle" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Often bought with" })).toHaveCount(0);
    await expect(page.locator(".sf-stats dt", { hasText: "Size" })).toBeVisible();
    await expect(page.locator(".sf-stats dt", { hasText: "Origin" })).toHaveCount(0);
  });
});

for (const width of [390, 1280]) {
  test.describe(`Calmer hero at ${width}px (#727)`, () => {
    test.use({ viewport: { width, height: 844 }, reducedMotion: "reduce" });

    test("one headline, a 16px sentence and a 48px action fit inside the hero with no decoration", async ({ page }) => {
      await page.goto(BASE, { waitUntil: "networkidle" });
      const hero = page.locator(".sf-hero");
      await expect(hero).toBeVisible();
      await expect(page.locator(".sf-hero-word, .sf-round-badge, .sf-hero-offer")).toHaveCount(0);
      const copy = page.locator(".sf-hero-slide:not([data-leaving]) .sf-hero-copy");
      await expect(copy.locator("p")).toHaveCSS("font-size", "16px");
      const cta = copy.locator(".sf-button");
      expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(48);
      const heroBox = (await hero.boundingBox())!;
      for (const part of [copy.locator("h2"), copy.locator("p"), cta]) {
        const b = (await part.boundingBox())!;
        expect(b.y).toBeGreaterThanOrEqual(heroBox.y);
        expect(b.y + b.height).toBeLessThanOrEqual(heroBox.y + heroBox.height);
        expect(b.x + b.width).toBeLessThanOrEqual(heroBox.x + heroBox.width);
      }
      const clipped = await copy.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
      expect(clipped).toBe(false);
      const controls = (await page.locator(".sf-hero-controls").boundingBox())!;
      const ctaBox = (await cta.boundingBox())!;
      expect(ctaBox.y + ctaBox.height).toBeLessThanOrEqual(controls.y);
    });
  });
}
