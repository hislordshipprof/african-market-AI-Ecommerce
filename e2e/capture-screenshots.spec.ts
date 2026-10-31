import { test, expect } from "@playwright/test";
import { resolve } from "path";

const BASE = "http://mama-ngozi.localhost:3000";
const OUT = resolve(__dirname, "..", "screenshots");

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844 },
  { name: "1440px", width: 1440, height: 900 },
];

const THEMES = ["light", "dark"] as const;

const PAGES = [
  { name: "home", path: "/", waitFor: "[data-testid='listing-card']" },
  { name: "category", path: "/categories/grains-and-flours", waitFor: "[data-testid='listing-card']" },
  { name: "search", path: "/search?q=ugu", waitFor: "ul li a" },
];

test.describe("Storefront screenshots", () => {
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const pg of PAGES) {
        test(`${pg.name}-${vp.name}-${theme}`, async ({ browser }) => {
          const context = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            colorScheme: theme,
          });
          const page = await context.newPage();
          await page.goto(`${BASE}${pg.path}`, { waitUntil: "networkidle" });

          await expect(
            page.locator(pg.waitFor).first(),
          ).toBeVisible({ timeout: 10000 });

          await page.screenshot({
            path: resolve(OUT, `${pg.name}-${vp.name}-${theme}.png`),
            fullPage: false,
          });
          await context.close();
        });
      }

      test(`product-${vp.name}-${theme}`, async ({ browser }) => {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          colorScheme: theme,
        });
        const page = await context.newPage();
        await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
        const firstCard = page.locator("[data-testid='listing-card']").first();
        await expect(firstCard).toBeVisible({ timeout: 10000 });
        await firstCard.click();
        await page.waitForURL(/\/listings\//);
        await expect(page.locator("#variants-heading")).toBeVisible({
          timeout: 5000,
        });

        await page.screenshot({
          path: resolve(OUT, `product-${vp.name}-${theme}.png`),
          fullPage: false,
        });
        await context.close();
      });
    }
  }
});
