import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { addItemToCart } from "./checkout-helpers";
import { storeUrl } from "./urls";

const base = storeUrl("mama-ngozi");

test.describe("Cart sticky checkout bar at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });

  test("page bottom clears the sticky bar and nav; line controls stay tappable", async ({
    page,
  }, testInfo) => {
    await addItemToCart(page);
    // A second, distinct listing: two cart lines, not qty 2 of one line (#117 AC1).
    await page.goto(`${base}/categories/grains-and-flours`);
    const other = page
      .getByTestId("listing-card")
      .filter({ hasNotText: "Garri" })
      .filter({ has: page.getByTestId("quick-add-btn") })
      .first();
    const otherName = (
      await other.locator(".sf-product-name").innerText()
    ).trim();
    await other.getByTestId("quick-add-btn").click();
    await expect(
      page.getByTestId("storefront-header").getByTestId("cart-count"),
    ).toHaveText("11");
    await expect(
      page.getByTestId("storefront-header").locator("[data-cart-pending]"),
    ).toBeHidden({ timeout: 10000 });
    await page.goto(`${base}/cart`);

    // Exactly two lines, and the last one is the other product.
    const rows = page.locator('[class*="lineActions"]:visible');
    await expect(rows).toHaveCount(2);
    const lastRow = page.locator('[class*="lineActions"]:visible').last();
    await expect(lastRow.locator("xpath=ancestor::li[1]")).toContainText(
      otherName,
    );

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
    const shots = "C:/E-commerce-project/.builder/screenshots-246";
    mkdirSync(shots, { recursive: true });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: `${shots}/cart-390-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${shots}/cart-390-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });

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
    await page.screenshot({ path: `${shots}/cart-390-scrolled-light.png` });
  });
});
