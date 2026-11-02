import { test, expect } from "@playwright/test";
const BASE = "http://mama-ngozi.localhost:3000";

test.describe("Phase 3 motion and depth", () => {
  test.use({ reducedMotion: "no-preference" });
  test("hero autoplay pauses independently on hover and the pause button", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(BASE);
    const hero = page.getByTestId("hero-carousel");
    const dots = hero.getByTestId("carousel-dot");
    await expect(hero).toHaveAttribute("data-autoplay", "running", { timeout: 15_000 });
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

  test("scroll-linked band exposes searchable keyboard chips", async ({ page }) => {
    await page.goto(BASE);
    const band = page.getByTestId("market-band");
    await expect(band.getByRole("link")).toHaveCount(6);
    await expect(band.getByRole("button")).toHaveCount(0);
    const chip = band.getByRole("link", { name: "Egusi", exact: true });
    await chip.focus();
    await expect(chip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/search\?q=egusi/);
    await expect(page.getByTestId("listing-card").first()).toContainText(/egusi/i);
  });

  test("hero remains edge to edge and layers overlap during a slide change", async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(BASE, { waitUntil: "networkidle" });
    const stage = page.locator(".sf-hero");
    await expect(stage).toBeVisible();
    await expect(stage).not.toHaveCSS("width", "0px");
    const geometry = await stage.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, viewport: document.documentElement.clientWidth }));
    expect(geometry.left).toBe(0);
    expect(geometry.right).toBe(geometry.viewport);
    await page.getByRole("button", { name: "Next slide", exact: true }).click();
    await expect(page.getByTestId("carousel-dot").nth(1)).toHaveAttribute("aria-current", "true");
    await expect(page.locator(".sf-hero-slide")).toHaveCount(1, { timeout: 3000 });
    await expect(page.locator(".sf-hero-slide")).toHaveCSS("position", "absolute");
    await expect(stage).toHaveCSS("height", "600px");
  });

  for (const vw of [1024, 1280, 1440, 1920]) {
    test(`hero offer tile does not overlap pills or subject label at ${vw}px`, async ({ page }) => {
      await page.setViewportSize({ width: vw, height: 1000 });
      await page.goto(BASE);
      const hero = page.locator(".sf-hero");
      await expect(hero).toBeVisible();
      const offerBox = await page.locator(".sf-hero-offer").boundingBox();
      if (!offerBox) return;
      const overlaps: string[] = [];
      for (const sel of [".sf-glass-one", ".sf-glass-two", ".sf-hero-subject-label"]) {
        const el = page.locator(sel);
        if (await el.count() === 0) continue;
        const vis = await el.isVisible().catch(() => false);
        if (!vis) continue;
        const box = await el.boundingBox();
        if (!box) continue;
        const xOverlap = offerBox.x < box.x + box.width && offerBox.x + offerBox.width > box.x;
        const yOverlap = offerBox.y < box.y + box.height && offerBox.y + offerBox.height > box.y;
        if (xOverlap && yOverlap) overlaps.push(sel);
      }
      expect(overlaps, `Offer tile overlaps at ${vw}px`).toEqual([]);
    });
  }

  test("mobile collection controls and keyboard scrolling agree", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE);
    const collections = page.getByTestId("collection-banners");
    const rail = collections.getByTestId("rail-scroll");
    await collections.scrollIntoViewIfNeeded();
    await expect.poll(() => rail.evaluate(element => element.scrollLeft)).toBe(0);
    await collections.getByRole("button", { name: "Scroll Collections right" }).click();
    await expect.poll(() => rail.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await rail.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => rail.evaluate(element => element.scrollLeft)).toBe(0);
    await page.keyboard.press("End");
    await expect.poll(() => rail.evaluate(element => Math.abs(element.scrollLeft - (element.scrollWidth - element.clientWidth)))).toBeLessThan(2);
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
    await page.waitForTimeout(2000);
    const card = page.getByTestId("listing-card").filter({ has: page.locator('[data-testid="quick-add-btn"]:enabled') }).filter({ hasNot: page.locator(".sf-product-fallback") }).first();
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

  test("reduced motion disables autoplay and keeps static wrapping chips", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(BASE);
    await expect(page.getByTestId("hero-carousel")).toHaveAttribute("data-autoplay", "paused");
    await expect(page.getByRole("button", { name: "Play slideshow" })).toBeDisabled();
    await expect(page.locator("html")).not.toHaveClass(/sf-reveal-ready/);
    await expect(page.locator(".sf-market-track")).toHaveCSS("transform", "none");
    await expect(page.locator(".sf-market-track")).toHaveCSS("flex-wrap", "wrap");
    await expect(page.getByTestId("market-band").getByRole("link")).toHaveCount(6);
  });
});
