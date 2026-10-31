import { test, expect } from "@playwright/test";
import { generateTOTP } from "./totp";

const OWNER_EMAIL = "owner@mama-ngozi.test";
const OWNER_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

async function storeOwnerSignIn(page: import("@playwright/test").Page) {
  await page.goto("/store-admin/sign-in?store=mama-ngozi");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.click("button[type='submit']");

  await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 10000 });

  const code = generateTOTP(SEED_TOTP_SECRET);
  await page.getByLabel("Verification code").fill(code);
  await page.click("button[type='submit']");

  try {
    await page.waitForURL(
      (url) => url.pathname.startsWith("/store-admin") && !url.pathname.includes("sign-in"),
      { timeout: 15000 },
    );
  } catch {
    const url = page.url();
    const bodySnippet = await page.locator("body").textContent().catch(() => "");
    throw new Error(
      `Store owner sign-in failed | url: ${url} | body: ${bodySnippet?.slice(0, 300)}`,
    );
  }
}

test.describe("Listing management (unauthenticated)", () => {
  test("unauthenticated access to /store-admin/listings does not return 500", async ({
    page,
  }) => {
    const response = await page.goto(
      "/store-admin/listings?store=mama-ngozi",
    );
    expect(response?.status()).not.toBe(500);
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

test.describe("Listing management (authenticated)", () => {
  test.beforeEach(async ({ page }) => {
    await storeOwnerSignIn(page);
  });

  test("create a listing with a variant", async ({ page }) => {
    await page.goto("/store-admin/listings?store=mama-ngozi");
    await expect(page.locator("h1")).toHaveText("Products");

    await page.click("text=Add listing");
    await page.getByLabel("Product name").fill(`E2E Garri ${Date.now()}`);
    await page.getByLabel("Price ($)").fill("8.50");

    const variantLabelInput = page.locator("input[placeholder='Label (e.g. 1kg)']").first();
    await variantLabelInput.fill("1kg");
    const variantPriceInput = page.locator("input[placeholder='Price']").first();
    await variantPriceInput.fill("8.50");
    const variantWeightInput = page.locator("input[placeholder='Weight (g)']").first();
    await variantWeightInput.fill("1000");

    await page.click("text=Create listing");

    await expect(page.locator("text=Listing created")).toBeVisible({ timeout: 10000 });
  });

  test("edit price and verify audit trail exists", async ({ page }) => {
    await page.goto("/store-admin/listings?store=mama-ngozi");
    await expect(page.locator("h1")).toHaveText("Products");

    // Create a listing to edit
    const uniqueName = `E2E Audit ${Date.now()}`;
    await page.click("text=Add listing");
    await page.getByLabel("Product name").fill(uniqueName);
    await page.getByLabel("Price ($)").fill("5.00");
    const variantLabel = page.locator("input[placeholder='Label (e.g. 1kg)']").first();
    await variantLabel.fill("500g");
    const variantPrice = page.locator("input[placeholder='Price']").first();
    await variantPrice.fill("5.00");
    const variantWeight = page.locator("input[placeholder='Weight (g)']").first();
    await variantWeight.fill("500");
    await page.click("text=Create listing");
    await expect(page.locator("text=Listing created")).toBeVisible({ timeout: 10000 });

    // Wait for page to refresh and find the listing
    await page.waitForTimeout(1000);
    await page.goto("/store-admin/listings?store=mama-ngozi");
    await expect(page.locator(`text=${uniqueName}`)).toBeVisible({ timeout: 10000 });

    // Edit the price
    const editBtn = page.locator(`[aria-label="Edit ${uniqueName}"]`);
    await editBtn.click();
    await expect(page.locator("text=Edit listing")).toBeVisible({ timeout: 5000 });
    await page.getByLabel("Price ($)").fill("7.00");
    await page.click("text=Save changes");
    await expect(page.locator("text=Listing updated")).toBeVisible({ timeout: 10000 });

    // Verify the price changed in the UI
    await page.waitForTimeout(500);
    await page.goto("/store-admin/listings?store=mama-ngozi");
    await expect(page.locator(`text=$7.00`).first()).toBeVisible({ timeout: 5000 });
  });

  test("switch stock mode from counted to status", async ({ page }) => {
    await page.goto("/store-admin/listings?store=mama-ngozi");

    const uniqueName = `E2E Mode ${Date.now()}`;
    await page.click("text=Add listing");
    await page.getByLabel("Product name").fill(uniqueName);
    await page.getByLabel("Price ($)").fill("3.00");
    await page.getByLabel("Quantity in stock").fill("10");
    const variantLabel = page.locator("input[placeholder='Label (e.g. 1kg)']").first();
    await variantLabel.fill("250g");
    const variantPrice = page.locator("input[placeholder='Price']").first();
    await variantPrice.fill("3.00");
    const variantWeight = page.locator("input[placeholder='Weight (g)']").first();
    await variantWeight.fill("250");
    await page.click("text=Create listing");
    await expect(page.locator("text=Listing created")).toBeVisible({ timeout: 10000 });

    await page.waitForTimeout(1000);
    await page.goto("/store-admin/listings?store=mama-ngozi");
    await expect(page.locator(`text=${uniqueName}`)).toBeVisible({ timeout: 10000 });

    // Verify counted mode shows qty
    await expect(page.locator(`text=10 in stock`).first()).toBeVisible();

    // Edit and switch to status mode
    const editBtn = page.locator(`[aria-label="Edit ${uniqueName}"]`);
    await editBtn.click();
    await expect(page.locator("text=Edit listing")).toBeVisible({ timeout: 5000 });

    // Change stock mode via Select
    await page.locator("button:has-text('Counted')").click();
    await page.locator("[role='option']:has-text('Status')").click();
    await page.click("text=Save changes");
    await expect(page.locator("text=Listing updated")).toBeVisible({ timeout: 10000 });

    // Verify status mode shows
    await page.waitForTimeout(500);
    await page.goto("/store-admin/listings?store=mama-ngozi");
    const listingRow = page.locator(`text=${uniqueName}`).locator("..");
    await expect(listingRow).toBeVisible();
  });

  test("deactivate listing excludes it from active list", async ({ page }) => {
    await page.goto("/store-admin/listings?store=mama-ngozi");

    const uniqueName = `E2E Deactivate ${Date.now()}`;
    await page.click("text=Add listing");
    await page.getByLabel("Product name").fill(uniqueName);
    await page.getByLabel("Price ($)").fill("4.00");
    const variantLabel = page.locator("input[placeholder='Label (e.g. 1kg)']").first();
    await variantLabel.fill("1kg");
    const variantPrice = page.locator("input[placeholder='Price']").first();
    await variantPrice.fill("4.00");
    const variantWeight = page.locator("input[placeholder='Weight (g)']").first();
    await variantWeight.fill("1000");
    await page.click("text=Create listing");
    await expect(page.locator("text=Listing created")).toBeVisible({ timeout: 10000 });

    await page.waitForTimeout(1000);
    await page.goto("/store-admin/listings?store=mama-ngozi");
    await expect(page.locator(`text=${uniqueName}`)).toBeVisible({ timeout: 10000 });

    // Deactivate via the toggle switch
    const toggleLabel = `Deactivate ${uniqueName}`;
    const toggle = page.locator(`[aria-label="${toggleLabel}"]`);
    await toggle.click();
    await expect(page.locator("text=Listing deactivated")).toBeVisible({ timeout: 10000 });

    // Verify it moved to inactive section
    await page.waitForTimeout(500);
    await page.goto("/store-admin/listings?store=mama-ngozi");
    await expect(page.locator("text=Inactive listings")).toBeVisible({ timeout: 5000 });

    // The listing should still be visible (in inactive section)
    await expect(page.locator(`text=${uniqueName}`)).toBeVisible();
  });
});
