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

test.describe("Hero image on a phone (#563 LCP)", () => {
  test.use({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true });

  test("the largest paint is the hero image, fetched eagerly at high priority", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const hero = page.locator("[data-testid='hero-carousel'] .sf-hero-background img").first();
    await expect(hero).toBeVisible({ timeout: 15000 });

    const lcpIsHero = await page.evaluate(() => new Promise<boolean>(resolve => {
      new PerformanceObserver(list => {
        const last = list.getEntries().at(-1) as PerformanceEntry & { element?: Element | null };
        resolve(!!last?.element?.closest(".sf-hero-background"));
      }).observe({ type: "largest-contentful-paint", buffered: true });
    }));
    expect(lcpIsHero).toBe(true);

    await expect(hero).not.toHaveAttribute("loading", "lazy");
    await expect(hero).toHaveAttribute("fetchpriority", "high");
    const preloadPriority = await hero.evaluate(img => {
      const srcset = img.getAttribute("srcset");
      const link = [...document.querySelectorAll("link[rel='preload'][as='image']")].find(l => l.getAttribute("imagesrcset") === srcset);
      return link?.getAttribute("fetchpriority") ?? null;
    });
    expect(preloadPriority).toBe("high");
  });
});

test.describe("First load without the animation library (#563 LCP)", () => {
  // The scripts the home page's HTML loads. Not every script the browser fetches: after idle, Next prefetches
  // linked routes (search, aisles), whose bundles do carry motion, so a network-wide check would race that.
  test("the home page's first-load scripts carry no motion code", async ({ request }) => {
    const html = await (await request.get(`${BASE}/`)).text();
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g), ...html.matchAll(/<link[^>]+as="script"[^>]+href="([^"]+)"/g)]
      .map(match => match[1].replaceAll("&amp;", "&"));
    expect(srcs.length).toBeGreaterThan(5);
    const bodies = await Promise.all(srcs.map(async src => ({ src, body: await (await request.get(new URL(src, BASE).href)).text() })));
    // "whileDrag" is in motion's prop list, which every motion bundle carries.
    expect(bodies.filter(({ body }) => body.includes('"whileDrag"')).map(({ src }) => src)).toEqual([]);
  });
});
