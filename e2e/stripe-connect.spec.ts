import { test, expect } from "@playwright/test";

test.describe("Checkout gate on storefront", () => {
  test("store without complete onboarding shows disabled checkout message", async ({
    page,
  }) => {
    await page.goto("http://mama-ngozi.localhost:3000/");
    await expect(
      page.getByText("This store is not yet accepting online orders"),
    ).toBeVisible();
  });

  test("store-admin payouts page loads for authenticated owner", async ({
    page,
  }) => {
    test.skip(true, "Requires real Stripe keys for full onboarding flow");
  });
});
