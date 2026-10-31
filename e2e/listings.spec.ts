import { test, expect } from "@playwright/test";

test.describe("Listing management", () => {
  test("unauthenticated access to /store-admin/listings does not return 500", async ({
    page,
  }) => {
    const response = await page.goto(
      "/store-admin/listings?store=mama-ngozi",
    );
    expect(response?.status()).not.toBe(500);
    // Server redirect to sign-in or a 404/not-found — either is acceptable
    // for an unauthenticated user. A 200 with sign-in content also works
    // (Next.js soft redirect within RSC).
    const url = page.url();
    const hasRedirected = /sign-in/.test(url);
    const hasSignInForm = await page.locator("input[type='email']").isVisible().catch(() => false);
    const isNotFound = response?.status() === 404;
    expect(hasRedirected || hasSignInForm || isNotFound).toBe(true);
  });

  test("sign-in page does not expose listings link", async ({ page }) => {
    await page.goto("/store-admin/sign-in?store=mama-ngozi");
    const productsLink = page.locator("a[href*='/store-admin/listings']");
    await expect(productsLink).toHaveCount(0);
  });
});
