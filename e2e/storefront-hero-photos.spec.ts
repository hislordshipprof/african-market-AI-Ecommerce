import sharp from "sharp";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { heroFocus } from "../src/lib/storefront/editorial";
import { storeUrl } from "./urls";

// #836: the hero's copy must stay readable on every photograph, and each photo's subject must stay in frame.
const linear = (c: number) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const luminance = (r: number, g: number, b: number) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Lowest contrast of text in `alpha` white over any pixel of the clip, with the copy hidden. */
async function worstContrast(page: Page, box: { x: number; y: number; width: number; height: number }, alpha: number) {
  const { data, info } = await sharp(await page.screenshot({ clip: box })).raw().toBuffer({ resolveWithObject: true });
  let worst = Infinity;
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const text = [r, g, b].map(c => alpha * 255 + (1 - alpha) * c) as [number, number, number];
    worst = Math.min(worst, ratio(luminance(...text), luminance(r, g, b)));
  }
  return worst;
}

async function currentSlide(page: Page): Promise<Locator> {
  await expect(page.locator(".sf-hero-slide[data-leaving]")).toHaveCount(0);
  return page.locator(".sf-hero-slide:not([data-leaving])");
}

for (const slug of ["mama-ngozi", "tante-marie"]) {
  for (const width of [390, 768, 1280]) {
    test.describe(`${slug} hero at ${width}px (#836)`, () => {
      test.use({ viewport: { width, height: 900 }, reducedMotion: "reduce" });

      test("copy passes WCAG AA on every photo and each photo's focal point stays in view", async ({ page }) => {
        await page.goto(`${storeUrl(slug)}/`);
        const dots = page.locator("[data-testid='carousel-dot']");
        await expect(dots.first()).toBeVisible({ timeout: 15000 });
        const slides = await dots.count();
        expect(slides).toBeGreaterThanOrEqual(3);
        for (let i = 0; i < slides; i++) {
          await dots.nth(i).click();
          const slide = await currentSlide(page);
          const img = slide.locator(".sf-hero-background img");
          await expect(img).toHaveJSProperty("complete", true);
          const src = decodeURIComponent((await img.getAttribute("src"))!.replace(/^.*[?&]url=([^&]+).*$/, "$1"));
          expect(src, `slide ${i + 1}`).toMatch(/^\/images\/hero\//);

          const hero = (await page.locator(".sf-hero").boundingBox())!;
          const heading = (await slide.locator("h2").boundingBox())!;
          const subtitle = (await slide.locator(".sf-hero-copy p").boundingBox())!;
          // Where the photo's focal point lands: object-position x% puts image x% at container x%.
          const [fx, fy] = heroFocus(src).split(" ").map(v => parseFloat(v) / 100);
          const focus = { x: hero.x + fx * hero.width, y: hero.y + fy * hero.height };
          expect(focus.x).toBeGreaterThan(hero.x);
          expect(focus.x).toBeLessThan(hero.x + hero.width);
          expect(focus.y).toBeLessThan(hero.y + hero.height);
          const underHeading = focus.x >= heading.x && focus.x <= heading.x + heading.width && focus.y >= heading.y && focus.y <= heading.y + heading.height;
          expect(underHeading, `slide ${i + 1} focal point under the heading`).toBe(false);

          const hide = await page.addStyleTag({ content: ".sf-hero-copy, .sf-glass-pill, .sf-hero-subject { visibility:hidden !important; }" });
          // Large heading (3:1), body subtitle drawn at 90% white (4.5:1).
          expect(await worstContrast(page, heading, 1), `slide ${i + 1} heading`).toBeGreaterThanOrEqual(3);
          expect(await worstContrast(page, subtitle, 0.9), `slide ${i + 1} subtitle`).toBeGreaterThanOrEqual(4.5);
          await hide.evaluate(style => (style as HTMLStyleElement).remove());
        }
      });
    });
  }
}

test.describe("Hero photo on a phone (#836)", () => {
  // isMobile is left off: with the desktop user agent it lays out at 980px before the viewport tag applies.
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });

  test("the first photo loads without shifting the layout", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { shift: number }).shift = 0;
      new PerformanceObserver(list => {
        for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
          if (!entry.hadRecentInput) (window as unknown as { shift: number }).shift += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto(`${storeUrl("mama-ngozi")}/`);
    const img = page.locator("[data-testid='hero-carousel'] .sf-hero-background img").first();
    await expect(img).toHaveJSProperty("complete", true, { timeout: 15000 });
    // A 3x phone gets the 1200px candidate, not the 1920px desktop one.
    expect(await img.evaluate(el => (el as HTMLImageElement).currentSrc)).toMatch(/w=1200\b/);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { shift: number }).shift)).toBeLessThan(0.1);
  });
});
