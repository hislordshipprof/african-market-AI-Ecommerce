import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

const OUT = resolve(__dirname, "..", "screenshots");
const base = "http://mama-ngozi.localhost:3000";

async function addItemToCart(page: Page) {
  await page.goto(`${base}/categories/grains-and-flours`);
  const card = page
    .getByTestId("listing-card")
    .filter({ hasText: "Garri" })
    .first();
  await card.getByTestId("quick-add-btn").click();
  for (let i = 0; i < 9; i++) await card.getByTestId("stepper-plus").click();
  await expect(
    page.getByTestId("storefront-header").getByTestId("cart-count"),
  ).toHaveText("10");
  await expect(
    page.getByTestId("storefront-header").locator("[data-cart-pending]"),
  ).toBeHidden({ timeout: 10000 });
}

test.describe("Checkout screenshots", () => {
  test.use({ reducedMotion: "reduce" });
  test.setTimeout(60_000);

  for (const vp of [
    { name: "390px", width: 390, height: 844 },
    { name: "1440px", width: 1440, height: 900 },
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`checkout-${vp.name}-${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.emulateMedia({ colorScheme: theme });

        await addItemToCart(page);
        await page.goto(`${base}/checkout`);

        await expect(
          page.getByRole("heading", { name: "Contact details" }),
        ).toBeVisible({ timeout: 15_000 });

        await page.screenshot({
          path: `${OUT}/checkout-${vp.name}-${theme}.png`,
          fullPage: true,
        });
      });
    }
  }
});
