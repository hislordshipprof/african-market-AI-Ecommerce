import { test, expect } from "@playwright/test";
const BASE = "http://mama-ngozi.localhost:3000";

test.describe("Phase 3 motion and depth", () => {
  test.use({ reducedMotion: "no-preference" });
  test("hero autoplay pauses independently on hover and the pause button", async ({ page }) => {
    await page.goto(BASE);
    const hero = page.getByTestId("hero-carousel");
    const dots = hero.getByTestId("carousel-dot");
    await expect(hero).toHaveAttribute("data-autoplay", "running");
    await hero.hover();
    await expect(hero).toHaveAttribute("data-autoplay", "paused");
    await page.waitForTimeout(6500);
    await expect(dots.first()).toHaveAttribute("aria-current", "true");
    await hero.getByRole("button", { name: "Pause slideshow" }).click();
    await page.locator(".sf-search-input").first().focus();
    await page.mouse.move(0, 0);
    await expect(hero).toHaveAttribute("data-autoplay", "paused");
    await page.waitForTimeout(6500);
    await expect(dots.first()).toHaveAttribute("aria-current", "true");
    await hero.getByRole("button", { name: "Play slideshow" }).click();
    await page.locator(".sf-search-input").first().focus();
    await page.mouse.move(0, 0);
    await expect(hero).toHaveAttribute("data-autoplay", "running");
    await expect(dots.nth(1)).toHaveAttribute("aria-current", "true", { timeout: 7500 });
  });

  test("marquee is present and can be paused", async ({ page }) => {
    await page.goto(BASE);
    const marquee = page.getByTestId("market-marquee");
    await expect(marquee).toContainText("Egusi");
    await marquee.getByRole("button", { name: "Pause product names" }).click();
    await expect(marquee).toHaveAttribute("data-paused", "true");
  });

  test("hero remains edge to edge and layers overlap during a slide change", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(BASE);
    const stage = page.locator(".sf-hero");
    const geometry = await stage.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, viewport: document.documentElement.clientWidth }));
    expect(geometry.left).toBe(0);
    expect(geometry.right).toBe(geometry.viewport);
    await page.getByRole("button", { name: "Next slide", exact: true }).click();
    await expect(page.getByTestId("carousel-dot").nth(1)).toHaveAttribute("aria-current", "true");
    await expect(page.locator(".sf-hero-slide")).toHaveCount(1);
    await expect(page.locator(".sf-hero-slide")).toHaveCSS("position", "absolute");
    await expect(stage).toHaveCSS("height", "600px");
  });

  test("mobile collection controls and snap scrolling agree", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE);
    const collections = page.getByTestId("collection-banners");
    await collections.scrollIntoViewIfNeeded();
    await expect(collections.locator('[aria-live="polite"]')).toHaveText(/^1 \/ /);
    await collections.getByRole("button", { name: "Next collection" }).click();
    await expect(collections.locator('[aria-live="polite"]')).toHaveText(/^2 \/ /);
    await expect.poll(() => collections.locator(".sf-coverflow").evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await collections.locator(".sf-coverflow").focus();
    await page.keyboard.press("Home");
    await expect(collections.locator('[aria-live="polite"]')).toHaveText(/^1 \/ /);
    await expect.poll(() => collections.locator(".sf-coverflow").evaluate(element => element.scrollLeft)).toBe(0);
  });

  test("quick view opens, selects a pack, adds to cart and restores focus", async ({ page }) => {
    await page.goto(`${BASE}/categories/grains-and-flours`);
    const card = page.getByTestId("listing-card").filter({ hasText: "Egusi" }).first();
    await card.hover();
    const trigger = card.getByRole("button", { name: /Quick view/ });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: /Quick view/ });
    await expect(dialog).toBeVisible();
    const packs = dialog.getByRole("group", { name: "Choose pack size" }).getByRole("button");
    await expect(packs.first()).toBeVisible();
    await packs.last().click();
    await expect(packs.last()).toHaveAttribute("aria-pressed", "true");
    await dialog.getByTestId("quick-add-btn").click();
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
    await dialog.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test("fly-to-cart updates the accessible badge immediately", async ({ page }) => {
    await page.goto(`${BASE}/categories/grains-and-flours`);
    const card = page.getByTestId("listing-card").filter({ has: page.locator('[data-testid="quick-add-btn"]:enabled') }).first();
    await expect(card.locator("img")).toBeVisible();
    await expect.poll(() => card.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await card.getByTestId("quick-add-btn").click();
    await expect(page.getByTestId("cart-flight")).toHaveCount(1);
    const header = page.getByTestId("storefront-header");
    await expect(header.getByTestId("cart-count")).toHaveText("1");
    await expect(header.locator('[aria-live="polite"]')).toContainText("1 item in cart");
    await expect(page.getByTestId("cart-flight")).toHaveCount(0);
  });

  test("unknown paths retain store branding with search and aisles", async ({ page }) => {
    await page.goto(`${BASE}/c/grains-flours`);
    await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
    await expect(page.getByTestId("store-name")).toHaveText("Mama Ngozi African Market");
    await expect(page.getByTestId("page-not-found").getByRole("link", { name: /Grains/ })).toBeVisible();
    await page.getByLabel("Search the store", { exact: true }).fill("egusi");
    await page.getByTestId("page-not-found").getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/search\?q=egusi/);
  });

  test("exact local search match is first and incidental matches are absent", async ({ page }) => {
    await page.goto(`${BASE}/search?q=egusi`);
    const names = page.getByTestId("listing-card").locator(".sf-product-name");
    await expect(names.first()).toContainText(/egusi/i);
    expect(await names.allTextContents()).not.toEqual(expect.arrayContaining([expect.stringMatching(/cassava|garden eggs/i)]));
  });

  test("reduced motion disables autoplay and keeps static marquee names", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(BASE);
    await expect(page.getByTestId("hero-carousel")).toHaveAttribute("data-autoplay", "paused");
    await expect(page.getByRole("button", { name: "Play slideshow" })).toBeDisabled();
    await expect(page.locator(".sf-marquee-track").first()).toHaveCSS("animation-name", "none");
  });
});
