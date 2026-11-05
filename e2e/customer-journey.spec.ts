import { storeUrl } from "./urls";
import { addItemToCart } from "./checkout-helpers";
import { test, expect, type Page } from "@playwright/test";

const base = storeUrl("mama-ngozi");

async function fillBasket(page: Page) {
  await addItemToCart(page);
  await page.goto(`${base}/cart`);
}

test.describe("Customer journey demo", () => {
  test.use({ reducedMotion: "reduce" });

  test("basket swap preference survives reload, pickup payment leads to tracking and swap approval", async ({
    page,
  }) => {
    await fillBasket(page);
    await page
      .getByRole("button", { name: /Replace with/ })
      .first()
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Let the store suggest a swap" })
      .click();
    await expect(
      page.getByRole("button", { name: /Replace with Store suggests/ }),
    ).toBeVisible({ timeout: 10000 });
    await page.reload();
    await expect(
      page.getByRole("button", { name: /Replace with Store suggests/ }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: /^Checkout/ })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Test payment" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Pickup.*Free/ }).click();
    await page.getByLabel("Full name").fill("Ada Demo");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Email (required)").fill("ada@example.test");
    await page.getByRole("button", { name: /Place demo order/ }).click();
    await expect(page).toHaveURL(/\/order\/[a-f0-9-]{36}\?placed=1/);
    await expect(
      page.getByRole("heading", { name: "Order placed", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("storefront-header").getByTestId("cart-count"),
    ).toHaveText("0");
    await page.getByRole("link", { name: "Track order", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Order progress" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Demo: advance order" }).click();
    await expect(
      page.getByRole("heading", { name: "Store accepted", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Demo: advance order" }).click();
    const orderUrl = page.url();
    await page.goto(`${orderUrl}/substitutions`);
    await expect(
      page.getByRole("heading", { name: "Your substitutions" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Swap", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Swap accepted" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("status").filter({ hasText: "Swap accepted" }),
    ).toBeVisible();
  });

  test("failed payment keeps the cart and can be retried", async ({ page }) => {
    await page.goto(`${base}/categories/spices-and-seasonings`);
    const count = page.getByTestId("storefront-header").getByTestId("cart-count");
    const card = page.getByTestId("listing-card").filter({ hasText: "Suya Spice" }).first();
    await card.getByTestId("quick-add-btn").click();
    await expect(card.getByTestId("stepper-qty")).toHaveText("1");
    const plus = card.getByTestId("stepper-plus");
    for (let i = 0; i < 9; i += 1) await plus.click();
    await expect(count).toHaveText("10");
    await page.goto(`${base}/cart`);
    await page
      .getByRole("link", { name: /^Checkout/ })
      .first()
      .click();
    await page.getByLabel("Full name").fill("Ada Demo");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Demo outcome").selectOption("declined");
    await page.getByRole("button", { name: /Place demo order/ }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: /declined/ }),
    ).toContainText("Test payment declined");
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(
      page.getByTestId("storefront-header").getByTestId("cart-count"),
    ).toHaveText("10");
    await page.getByLabel("Demo outcome").selectOption("success");
    await page.getByRole("button", { name: /Place demo order/ }).click();
    await expect(page).toHaveURL(/\?placed=1$/);
  });

  test("demo gate is open: gated pages serve checkout, not a closed-flow notice", async ({
    page,
  }) => {
    await page.goto(`${base}/checkout`);
    await expect(
      page.getByRole("heading", { name: "Checkout opens soon" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Checkout" }),
    ).toBeVisible();
  });
});
