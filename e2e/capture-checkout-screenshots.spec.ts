import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { addItemToCart } from "./checkout-helpers";
import { storeUrl } from "./urls";

const OUT = resolve(__dirname, "..", "screenshots");
const base = storeUrl("mama-ngozi");

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
