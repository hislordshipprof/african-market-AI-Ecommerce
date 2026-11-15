import { storeUrl } from "./urls";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

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

/** The final largest-paint candidate: the one still last after a second with no new entry. */
function finalLcp(page: Page) {
  return page.evaluate(() => new Promise<{ hero: boolean; time: number }>(resolve => {
    let timer = 0;
    new PerformanceObserver(list => {
      const last = list.getEntries().at(-1) as PerformanceEntry & { element?: Element | null };
      window.clearTimeout(timer);
      timer = window.setTimeout(() => resolve({ hero: !!last.element?.closest(".sf-hero-background"), time: last.startTime }), 1000);
    }).observe({ type: "largest-contentful-paint", buffered: true });
  }));
}

/** Paths of the scripts the home page's HTML loads (src and preload). */
async function htmlScripts(request: APIRequestContext) {
  const html = await (await request.get(`${BASE}/`)).text();
  return [...html.matchAll(/<script[^>]+src="([^"]+)"/g), ...html.matchAll(/<link[^>]+as="script"[^>]+href="([^"]+)"/g)]
    .map(match => match[1].replaceAll("&amp;", "&"));
}

test.describe("Hero image on a phone (#563 LCP)", () => {
  test.use({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true });

  test("the largest paint is the hero image, fetched eagerly at high priority", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const hero = page.locator("[data-testid='hero-carousel'] .sf-hero-background img").first();
    await expect(hero).toBeVisible({ timeout: 15000 });
    expect((await finalLcp(page)).hero).toBe(true);

    await expect(hero).not.toHaveAttribute("loading", "lazy");
    await expect(hero).toHaveAttribute("fetchpriority", "high");
    const preloadPriority = await hero.evaluate(img => {
      const srcset = img.getAttribute("srcset");
      const link = [...document.querySelectorAll("link[rel='preload'][as='image']")].find(l => l.getAttribute("imagesrcset") === srcset);
      return link?.getAttribute("fetchpriority") ?? null;
    });
    expect(preloadPriority).toBe("high");
  });

  // Lighthouse counts a script requested before the largest paint toward it; the prompt's chunk used to be
  // requested a frame after the hero was revealed, so it raced the paint (#563).
  test("the install prompt's code is requested well after the hero paints", async ({ page, request }) => {
    const own = new Set((await htmlScripts(request)).map(src => new URL(src, BASE).pathname));
    await page.goto(`${BASE}/`);
    await expect(page.locator("[data-testid='hero-carousel'] .sf-hero-background img").first()).toBeVisible({ timeout: 15000 });
    const lcp = await finalLcp(page);
    const bodies = new Map<string, string>();
    let prompt: { path: string; start: number } | undefined;
    await expect.poll(async () => {
      const scripts = await page.evaluate(() => performance.getEntriesByType("resource")
        .map(entry => ({ path: new URL(entry.name).pathname, start: entry.startTime }))
        .filter(entry => entry.path.endsWith(".js")));
      for (const script of scripts.filter(({ path }) => !own.has(path))) {
        if (!bodies.has(script.path)) bodies.set(script.path, await (await request.get(new URL(script.path, BASE).href)).text());
        if (bodies.get(script.path)!.includes("to your Home Screen")) prompt = script;
      }
      return prompt?.path;
    }, { timeout: 10000 }).toBeTruthy();
    expect(prompt!.start - lcp.time).toBeGreaterThan(500);
  });
});

test.describe("First load without the animation library (#563 LCP)", () => {
  // The scripts the home page's HTML loads. Not every script the browser fetches: after idle, Next prefetches
  // linked routes (search, aisles), whose bundles do carry motion, so a network-wide check would race that.
  test("the home page's first-load scripts carry no motion code", async ({ request }) => {
    const srcs = await htmlScripts(request);
    expect(srcs.length).toBeGreaterThan(5);
    const bodies = await Promise.all(srcs.map(async src => ({ src, body: await (await request.get(new URL(src, BASE).href)).text() })));
    // "whileDrag" is in motion's prop list, which every motion bundle carries.
    expect(bodies.filter(({ body }) => body.includes('"whileDrag"')).map(({ src }) => src)).toEqual([]);
  });
});
