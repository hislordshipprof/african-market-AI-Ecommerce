import { test, expect } from "@playwright/test";
import { addItemToCart } from "./checkout-helpers";
import { storeUrl } from "./urls";

const base = storeUrl("mama-ngozi");

test.describe("Cart sticky checkout bar at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });

  test("page bottom clears the sticky bar and nav; line controls stay tappable", async ({
    page,
  }, testInfo) => {
    await addItemToCart(page);
    await page.goto(`${base}/cart`);

    const bar = page.locator('[class*="mobileAction"]');
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(bar).toBeVisible();
    await expect(nav).toBeVisible();

    // The bar sits above the nav without overlapping it.
    const barBox = (await bar.boundingBox())!;
    const navBox = (await nav.boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(navBox.y);

    // The page's bottom padding covers everything the fixed stack occupies
    // (viewport bottom up to the top of the checkout bar) plus a scroll margin.
    const viewportHeight = page.viewportSize()!.height;
    const padding = await page
      .locator('[class*="_page"]')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    expect(padding).toBeGreaterThanOrEqual(viewportHeight - barBox.y + 8);

    // Cart line controls are tappable (top element at their centre) when the
    // last line is scrolled to the lower part of the viewport.
    const lastActions = page.locator('[class*="lineActions"]:visible').last();
    await lastActions.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const bar = document.querySelector('[class*="mobileAction"]')!;
      const barTop = bar.getBoundingClientRect().top;
      window.scrollBy(0, r.bottom - (barTop - 12));
    });
    for (const control of [
      lastActions.getByTestId("quick-add-stepper"),
      lastActions.getByRole("button", { name: /^Remove (?!one )/ }),
    ]) {
      await expect(control).toBeVisible();
      const box = (await control.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(barBox.y);
      const tappable = await control.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return !!top && el.contains(top);
      });
      expect(tappable).toBe(true);
    }

    await testInfo.attach("cart-390x844.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
