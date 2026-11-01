import { test, expect } from "@playwright/test";

const BASE = "http://mama-ngozi.localhost:3000";

test.describe("Design round 4", () => {
  for (const [width, count] of [[390, 2.25], [1024, 3.5], [1440, 4.5], [1920, 5.5]]) {
    test("rails bleed to the viewport with whole cards at " + width, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.waitForSelector(".sf-rail-scroll", { timeout: 10000 });
      const rails = page.locator(".sf-rail-scroll");
      expect(await rails.count()).toBeGreaterThan(4);
      for (const rail of await rails.all()) {
        const geometry = await rail.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const cards = [...element.querySelectorAll<HTMLElement>(".sf-rail-item,.sf-category-tile")].map(card => card.getBoundingClientRect());
          const gap = parseFloat(getComputedStyle(element).columnGap);
          const clippedBy: string[] = [];
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (["hidden", "clip", "auto", "scroll"].includes(getComputedStyle(parent).overflowX) && parent.getBoundingClientRect().right < document.documentElement.clientWidth - 1) clippedBy.push(parent.className);
          }
          return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth,
            padding: getComputedStyle(element).paddingRight, clippedBy,
            cardCount: cards.length, whole: cards.filter(card => card.left >= rect.left - 1 && card.right <= rect.right + 1).length,
            visibleCount: cards.length ? (rect.width + gap) / (cards[0].width + gap) : 0,
            first: cards[0]?.left };
        });
        expect(geometry.right).toBeCloseTo(geometry.viewport, 0);
        expect(geometry.padding).toBe("0px");
        expect(geometry.clippedBy).toEqual([]);
        if (!geometry.cardCount) continue;
        expect(geometry.first).toBeCloseTo(geometry.left, 0);
        expect(geometry.visibleCount).toBeCloseTo(count, 1);
        expect(geometry.whole).toBe(Math.min(Math.floor(count), geometry.cardCount));
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  test("category photos fill their clipped circles", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    const images = page.locator(".sf-category-tile .sf-product-image img");
    expect(await images.count()).toBeGreaterThan(0);
    for (const image of await images.all()) {
      await expect(image).toHaveCSS("object-fit", "cover");
      await expect(image).toHaveCSS("padding", "0px");
      const size = await image.evaluate(element => {
        const parent = element.parentElement!;
        const box = parent.getBoundingClientRect();
        const image = element.getBoundingClientRect();
        return { radius: getComputedStyle(parent).borderRadius, overflow: getComputedStyle(parent).overflow, width: box.width, height: box.height, imageWidth: image.width, imageHeight: image.height };
      });
      expect(size.radius).toBe("50%");
      expect(size.overflow).toBe("hidden");
      expect(size.width).toBeCloseTo(size.height, 0);
      expect(size.imageWidth).toBeCloseTo(size.width, 0);
      expect(size.imageHeight).toBeCloseTo(size.height, 0);
    }
  });

  test("hydration enables once-only off-screen reveals and responds to reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveClass(/sf-reveal-ready/);
    const section = page.locator("[data-sf-reveal]").filter({ has: page.getByTestId("collection-banners") }).first();
    await expect(section).toHaveCSS("opacity", "0");
    await expect(section).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 24)");
    await expect(section).toHaveCSS("transition-duration", "0.5s, 0.5s");
    await section.scrollIntoViewIfNeeded();
    await expect(section).toHaveAttribute("data-revealed", "true");
    await expect(section).toHaveCSS("opacity", "1");
    await page.evaluate(() => scrollTo(0, 0));
    await expect(section).toHaveAttribute("data-revealed", "true");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator("html")).not.toHaveClass(/sf-reveal-ready/);
  });

  test("server HTML remains visible without JavaScript", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto(BASE, { waitUntil: "networkidle" });
      await expect(page.locator("html")).not.toHaveClass(/sf-reveal-ready/);
      const reveals = page.locator("[data-sf-reveal]");
      expect(await reveals.count()).toBeGreaterThan(0);
      for (const reveal of await reveals.all()) await expect(reveal).toHaveCSS("opacity", "1");
    } finally { await context.close(); }
  });

  test("band follows scrolling but never autoplays", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(BASE, { waitUntil: "networkidle" });
    const band = page.locator(".sf-market-track");
    await page.getByTestId("market-band").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const before = await band.evaluate(element => getComputedStyle(element).transform);
    await page.waitForTimeout(600);
    await expect(band).toHaveCSS("transform", before);
    await page.evaluate(() => scrollBy(0, 160));
    await expect.poll(() => band.evaluate(element => getComputedStyle(element).transform)).not.toBe(before);
    await expect(band).toHaveCSS("animation-name", "none");
  });

  for (const name of ["Egusi", "Garri", "Ogbono", "Suya spice", "Ata rodo", "Fufu flour"]) {
    test("band chip searches for " + name, async ({ page }) => {
      await page.goto(BASE, { waitUntil: "networkidle" });
      const chip = page.getByTestId("market-band").getByRole("link", { name, exact: true });
      await chip.focus();
      await expect(chip).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(name.toLowerCase());
      expect(new URL(page.url()).pathname).toBe("/search");
    });
  }

  test("a real image failure is retried once before showing the failure state", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const requests: string[] = [];
    await page.route("**/_next/image?*", async route => {
      const source = new URL(route.request().url()).searchParams.get("url") || "";
      if (/products|catalog-image|\/catalog\//.test(source)) {
        requests.push(source);
        await route.abort();
      } else await route.continue();
    });
    await page.goto(BASE + "/listings/mn_egusi");
    const photo = page.locator(".sf-detail-photo");
    await expect(photo).toContainText("Photo unavailable");
    expect(requests.filter(source => !source.includes("retry=1")).length).toBeGreaterThan(0);
    const original = requests.find(source => !source.includes("retry=1"))!;
    expect(requests.filter(source => source === original + (original.includes("?") ? "&" : "?") + "retry=1")).toHaveLength(1);
  });
});
