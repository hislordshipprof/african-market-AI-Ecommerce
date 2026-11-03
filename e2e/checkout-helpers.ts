import { expect, type Page } from "@playwright/test";
import { storeUrl } from "./urls";

const base = storeUrl("mama-ngozi");

export async function addItemToCart(page: Page) {
  await page.goto(`${base}/categories/grains-and-flours`);
  const card = page
    .getByTestId("listing-card")
    .filter({ hasText: "Garri" })
    .first();
  const count = page.getByTestId("storefront-header").getByTestId("cart-count");
  await card.getByTestId("quick-add-btn").click();
  await expect(card.getByTestId("stepper-qty")).toHaveText("1");
  // Each plus reads the quantity from the last render, so the next click waits for that render.
  for (let qty = 1; qty < 10; qty++) {
    await card.getByTestId("stepper-plus").click();
    await expect(card.getByTestId("stepper-qty")).toHaveText(String(qty + 1));
  }
  await expect(count).toHaveText("10");
  await expect(
    page.getByTestId("storefront-header").locator("[data-cart-pending]"),
  ).toBeHidden({ timeout: 10000 });
}
