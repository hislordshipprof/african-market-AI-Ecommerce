import { test, expect, type Page } from "@playwright/test";

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

test.describe("Guest checkout flow", () => {
  test.use({ reducedMotion: "reduce" });

  test("checkout page shows guest contact form with required fields", async ({
    page,
  }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    await expect(
      page.getByRole("heading", { name: "Contact details" }),
    ).toBeVisible();
    await expect(page.getByLabel("Full name")).toBeVisible();
    await expect(page.getByLabel("Phone number (required)")).toBeVisible();
    await expect(page.getByLabel("Email (required)")).toBeVisible();
  });

  test("checkout shows buffer disclosure text", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    await expect(
      page.getByText("10% buffer, capped at $20"),
    ).toBeVisible();
  });

  test("checkout validates required contact fields before payment", async ({
    page,
  }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    await page.getByRole("button", { name: /Place demo order|Pay/ }).click();

    await expect(
      page.getByText("Enter the name for your order"),
    ).toBeVisible();
  });

  test("fulfillment options are visible", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    await expect(
      page.getByRole("button", { name: /Pickup.*Free/ }),
    ).toBeVisible();
  });

  test("order summary shows line items and totals", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    const review = page.locator("#review");
    await expect(
      review.getByRole("heading", { name: "Your order", exact: true }),
    ).toBeVisible();
    await expect(review.getByText("Subtotal")).toBeVisible();
    await expect(review.getByText("Temporary swap buffer")).toBeVisible();
    await expect(
      review.getByText("Authorization hold", { exact: true }),
    ).toBeVisible();
  });

  test("demo checkout places order successfully", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/cart`);
    await page
      .getByRole("link", { name: /^Checkout/ })
      .first()
      .click();

    await page.getByRole("button", { name: /Pickup.*Free/ }).click();
    await page.getByLabel("Full name").fill("E2E Guest");
    await page.getByLabel("Phone number (required)").fill("2025550199");
    await page.getByLabel("Email (required)").fill("e2e@test.example");
    await page.getByRole("button", { name: /Place demo order/ }).click();

    await expect(page).toHaveURL(/\/order\/[a-f0-9-]{36}\?placed=1/, {
      timeout: 15000,
    });
    await expect(
      page.getByRole("heading", { name: "Order placed", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("storefront-header").getByTestId("cart-count"),
    ).toHaveText("0");
  });

  test("promo code WELCOME10 is accepted", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    await page.getByPlaceholder("Try WELCOME10").fill("WELCOME10");
    await page
      .getByRole("button", { name: "Apply" })
      .click();
    await expect(page.getByText("10% off applied")).toBeVisible();
  });
});
