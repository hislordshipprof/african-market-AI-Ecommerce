import { expect, type Page } from "@playwright/test";
import { storeUrl } from "./urls";

const base = storeUrl("mama-ngozi");

export async function addItemToCart(page: Page) {
  await page.goto(`${base}/categories/grains-and-flours`);
  const count = page.getByTestId("storefront-header").getByTestId("cart-count");
  const card = page.getByTestId("listing-card").filter({ hasText: "Yellow Garri" }).first();
  await card.getByTestId("quick-add-btn").click();
  await expect(card.getByTestId("stepper-qty")).toHaveText("1");
  // A plus click can land on a render that already applied it, so repeat until the quantity grows.
  let qty = 1;
  while (qty < 10) {
    const before = qty;
    await expect.poll(async () => {
      const shown = Number(await card.getByTestId("stepper-qty").innerText());
      if (shown === before) await card.getByTestId("stepper-plus").click();
      return Number(await card.getByTestId("stepper-qty").innerText());
    }).toBeGreaterThan(before);
    qty = Number(await card.getByTestId("stepper-qty").innerText());
  }
  await expect(count).toHaveText("10");
  await expect(
    page.getByTestId("storefront-header").locator("[data-cart-pending]"),
  ).toBeHidden({ timeout: 10000 });
}
