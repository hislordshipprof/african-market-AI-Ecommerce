import { expect, type Page } from "@playwright/test";
import { storeUrl } from "./urls";

const base = storeUrl("mama-ngozi");

export async function addItemToCart(page: Page) {
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
