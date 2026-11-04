import { expect, type Page } from "@playwright/test";
import { storeUrl } from "./urls";

const base = storeUrl("mama-ngozi");

export async function addItemToCart(page: Page) {
  await page.goto(`${base}/categories/grains-and-flours`);
  const count = page.getByTestId("storefront-header").getByTestId("cart-count");
  const card = page.getByTestId("listing-card").filter({ hasText: "Yellow Garri" }).first();
  await card.getByTestId("quick-add-btn").click();
  await expect(card.getByTestId("stepper-qty")).toHaveText("1");
  const plus = card.getByTestId("stepper-plus");
  for (let i = 0; i < 9; i += 1) await plus.click();
  await expect(count).toHaveText("10");
  await expect(
    page.getByTestId("storefront-header").locator("[data-cart-pending]"),
  ).toBeHidden({ timeout: 20000 });
}
