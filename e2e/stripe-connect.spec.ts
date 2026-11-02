import { storeUrl } from "./urls";
import { test, expect } from "@playwright/test";

test.describe("Checkout gate on storefront", () => {
  test("store without complete onboarding shows disabled checkout message", async ({
    page,
  }) => {
    await page.goto(`${storeUrl("mama-ngozi")}/`);
    await expect(
      page.getByText("This store is not yet accepting online orders"),
    ).toBeVisible();
  });

  test("unauthenticated user accessing payouts page is redirected to sign-in", async ({
    page,
  }) => {
    await page.goto(
      `${storeUrl("mama-ngozi")}/store-admin/payouts?store=mama-ngozi`,
    );
    await expect(page).toHaveURL(/sign-in/);
  });
});
