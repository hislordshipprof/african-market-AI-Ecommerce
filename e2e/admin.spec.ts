import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = "Test1234!";

test.describe("Platform admin console", () => {
  test("sign-in page renders email and password fields", async ({ page }) => {
    await page.goto("http://localhost:3000/admin/sign-in");
    await expect(page.locator("h1")).toHaveText("Platform Admin");
    await expect(page.locator("input[type='email']")).toBeVisible();
    await expect(page.locator("input[type='password']")).toBeVisible();
    await expect(page.locator("button[type='submit']")).toHaveText("Sign in");
  });

  test("unauthenticated access to /admin redirects to sign-in", async ({
    page,
  }) => {
    await page.goto("http://localhost:3000/admin");
    await expect(page).toHaveURL(/\/admin\/sign-in/);
  });

  test("unauthenticated access to /admin/stores redirects to sign-in", async ({
    page,
  }) => {
    await page.goto("http://localhost:3000/admin/stores");
    await expect(page).toHaveURL(/\/admin\/sign-in/);
  });

  test("sign-in with valid credentials reaches stores or 2FA", async ({
    page,
  }) => {
    await page.goto("http://localhost:3000/admin/sign-in");
    await page.fill("input[type='email']", ADMIN_EMAIL);
    await page.fill("input[type='password']", ADMIN_PASSWORD);
    await page.click("button[type='submit']");

    await page.waitForURL(/\/(admin\/stores|admin\/sign-in)/, {
      timeout: 10000,
    });

    const url = page.url();
    const atStores = url.includes("/admin/stores");
    const at2FA =
      url.includes("/admin/sign-in") &&
      (await page
        .locator("text=Enter the 6-digit code")
        .isVisible()
        .catch(() => false));

    expect(atStores || at2FA).toBe(true);
  });
});

test.describe("Store management (authenticated)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:3000/admin/sign-in");
    await page.fill("input[type='email']", ADMIN_EMAIL);
    await page.fill("input[type='password']", ADMIN_PASSWORD);
    await page.click("button[type='submit']");
    await page.waitForURL("**/admin/stores", { timeout: 10000 });
  });

  test("stores list page shows seeded stores", async ({ page }) => {
    await expect(page.locator("h1")).toHaveText("Stores");
    await expect(page.locator("text=mama-ngozi")).toBeVisible();
    await expect(page.locator("text=tante-marie")).toBeVisible();
  });

  test("create store form validates unique slug", async ({ page }) => {
    await page.click("text=Create store");
    await expect(page).toHaveURL(/\/admin\/stores\/new/);

    await page.fill("input[name='slug']", "mama-ngozi");
    await page.fill("input[name='name']", "Duplicate Test");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=already exists")).toBeVisible();
  });

  test("create and then edit a store", async ({ page }) => {
    const slug = `e2e-test-${Date.now()}`;

    await page.click("text=Create store");
    await page.fill("input[name='slug']", slug);
    await page.fill("input[name='name']", "E2E Test Store");
    await page.click("button[type='submit']:has-text('Create store')");

    await page.waitForURL("**/admin/stores", { timeout: 10000 });
    await expect(page.locator(`text=${slug}`)).toBeVisible();

    await page.locator(`tr:has-text("${slug}") a:has-text("Edit")`).click();
    await page.waitForURL(/\/admin\/stores\//, { timeout: 5000 });

    await page.fill("input[name='name']", "E2E Test Store Updated");
    await page.click("button[type='submit']:has-text('Save changes')");

    await page.waitForURL("**/admin/stores", { timeout: 10000 });
    await expect(page.locator("text=E2E Test Store Updated")).toBeVisible();
  });

  test("storefront is reachable after store creation", async ({ page }) => {
    const slug = `e2e-live-${Date.now()}`;

    await page.click("text=Create store");
    await page.fill("input[name='slug']", slug);
    await page.fill("input[name='name']", "E2E Live Store");
    await page.click("button[type='submit']:has-text('Create store')");
    await page.waitForURL("**/admin/stores", { timeout: 10000 });

    await page.goto(`http://${slug}.localhost:3000/`);
    await expect(page.locator("h1")).toHaveText("E2E Live Store");
  });

  test("suspending a store takes its storefront offline", async ({ page }) => {
    const slug = `e2e-suspend-${Date.now()}`;

    await page.click("text=Create store");
    await page.fill("input[name='slug']", slug);
    await page.fill("input[name='name']", "E2E Suspend Store");
    await page.click("button[type='submit']:has-text('Create store')");
    await page.waitForURL("**/admin/stores", { timeout: 10000 });

    await page
      .locator(`tr:has-text("${slug}") button:has-text("Suspend")`)
      .click();
    await expect(
      page.locator(`tr:has-text("${slug}") text=suspended`),
    ).toBeVisible({ timeout: 5000 });

    await page.goto(`http://${slug}.localhost:3000/`);
    await expect(page.locator("text=temporarily offline")).toBeVisible();
  });

  test("brand color nudge notice shows when color is adjusted", async ({
    page,
  }) => {
    const slug = `e2e-nudge-${Date.now()}`;

    await page.click("text=Create store");
    await page.fill("input[name='slug']", slug);
    await page.fill("input[name='name']", "E2E Nudge Store");
    await page.fill("input[name='brandColor']", "#EEEEEE");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=adjusted")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("text=contrast")).toBeVisible();
  });
});
