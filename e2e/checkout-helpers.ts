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
  await expect(count).toHaveText("1");

  // A plus click can be dropped while the stepper re-renders. Click until the count is 10.
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = (await count.innerText()).trim();
    if (current === "10") break;
    const n = Number(current);
    await card.getByTestId(n < 10 ? "stepper-plus" : "stepper-minus").click();
    await expect(count).not.toHaveText(current, { timeout: 2000 }).catch(() => {});
  }
  await expect(count).toHaveText("10");
  await expect(
    page.getByTestId("storefront-header").locator("[data-cart-pending]"),
  ).toBeHidden({ timeout: 10000 });
}
