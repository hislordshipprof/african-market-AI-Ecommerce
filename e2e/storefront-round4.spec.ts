import { storeUrl } from "./urls";
import { test, expect } from "@playwright/test";

const BASE = storeUrl("mama-ngozi");

test.describe("Storefront motion and no-script", () => {
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
});
