import { test, expect } from "@playwright/test";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

function generateTotpCode(): string {
  return generateTOTP(SEED_TOTP_SECRET);
}

async function adminSignIn(page: import("@playwright/test").Page) {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.click("button[type='submit']");

  await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 10000 });

  const code = generateTotpCode();
  await page.getByLabel("Verification code").fill(code);
  await page.click("button[type='submit']");

  try {
    await page.waitForURL("**/admin/stores", { timeout: 15000 });
  } catch {
    const url = page.url();
    const errText = await page.locator(".bg-red-50").textContent().catch(() => "");
    const bodySnippet = await page.locator("body").textContent().catch(() => "");
    throw new Error(
      `Post-TOTP redirect failed | url: ${url} | error: "${errText}" | body: ${bodySnippet?.slice(0, 300)}`,
    );
  }
}

test.describe("Platform admin console", () => {
  test("sign-in page renders email and password fields", async ({ page }) => {
    await page.goto("/admin/sign-in");
    await expect(page.locator("h1")).toHaveText("Platform Admin");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.locator("button[type='submit']")).toHaveText("Sign in");
  });

  test("unauthenticated access to /admin redirects to sign-in", async ({
    page,
  }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/sign-in/);
  });

  test("unauthenticated access to /admin/stores redirects to sign-in (not 500)", async ({
    page,
  }) => {
    const response = await page.goto("/admin/stores");
    expect(response?.status()).not.toBe(500);
    await expect(page).toHaveURL(/\/admin\/sign-in/);
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("sign-in with valid credentials and TOTP reaches stores", async ({
    page,
  }) => {
    await adminSignIn(page);
    await expect(page.locator("h1")).toHaveText("Stores");
  });
});

test.describe("Store management (authenticated)", () => {
  test.beforeEach(async ({ page }) => {
    await adminSignIn(page);
  });

  test("stores list page shows seeded stores", async ({ page }) => {
    await expect(page.locator("h1")).toHaveText("Stores");
    await expect(page.locator("text=mama-ngozi")).toBeVisible();
    await expect(page.locator("text=tante-marie")).toBeVisible();
  });

  test("create store form validates unique slug", async ({ page }) => {
    await page.click("text=Create store");
    await expect(page).toHaveURL(/\/admin\/stores\/new/);

    await page.getByLabel("Slug").fill("mama-ngozi");
    await page.getByLabel("Store name").fill("Duplicate Test");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=already exists")).toBeVisible();
  });

  test("create store form rejects reserved slug", async ({ page }) => {
    await page.click("text=Create store");
    await page.getByLabel("Slug").fill("admin");
    await page.getByLabel("Store name").fill("Reserved Slug Test");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=reserved")).toBeVisible();
  });

  test("form preserves entered values after validation error", async ({ page }) => {
    await page.click("text=Create store");
    await expect(page).toHaveURL(/\/admin\/stores\/new/);

    const testName = `Preserved Store ${Date.now()}`;
    await page.getByLabel("Slug").fill("mama-ngozi");
    await page.getByLabel("Store name").fill(testName);
    await page.getByLabel("Pickup enabled").check();
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=already exists")).toBeVisible();
    await expect(page.getByLabel("Store name")).toHaveValue(testName);
    await expect(page.getByLabel("Pickup enabled")).toBeChecked();
  });

  test("create and then edit a store", async ({ page }) => {
    const slug = `e2e-test-${Date.now()}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Test Store");
    await page.click("button[type='submit']:has-text('Create store')");

    await page.waitForURL("**/admin/stores", { timeout: 10000 });
    await expect(page.locator(`text=${slug}`)).toBeVisible();

    await page.locator(`tr:has-text("${slug}") a:has-text("Edit")`).click();
    await page.waitForURL(/\/admin\/stores\//, { timeout: 5000 });

    await page.getByLabel("Store name").fill("E2E Test Store Updated");
    await page.click("button[type='submit']:has-text('Save changes')");

    await page.waitForURL("**/admin/stores", { timeout: 10000 });
    await expect(page.locator("text=E2E Test Store Updated")).toBeVisible();
  });

  test("storefront is reachable after store creation", async ({ page }) => {
    const slug = `e2e-live-${Date.now()}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Live Store");
    await page.click("button[type='submit']:has-text('Create store')");
    await page.waitForURL("**/admin/stores", { timeout: 10000 });

    await page.goto(`http://${slug}.localhost:3000/`);
    await expect(page.locator("h1")).toHaveText("E2E Live Store");
  });

  test("suspending a store takes its storefront offline", async ({ page }) => {
    const slug = `e2e-suspend-${Date.now()}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Suspend Store");
    await page.click("button[type='submit']:has-text('Create store')");
    await page.waitForURL("**/admin/stores", { timeout: 10000 });

    await page
      .locator(`tr:has-text("${slug}") button:has-text("Suspend")`)
      .click();
    await expect(
      page.locator("tr", { hasText: slug }).getByText("suspended"),
    ).toBeVisible({ timeout: 5000 });

    await page.goto(`http://${slug}.localhost:3000/`);
    await expect(page.locator("text=temporarily offline")).toBeVisible();
  });

  test("brand color nudge notice shows when color is adjusted", async ({
    page,
  }) => {
    const slug = `e2e-nudge-${Date.now()}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Nudge Store");
    await page.getByLabel("Brand color").fill("#EEEEEE");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=adjusted")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("text=contrast")).toBeVisible();
  });
});

test.describe("Layout regression", () => {
  test("sign-in card is at least 320px wide at 1280 viewport", async ({ page }) => {
    await page.goto("/admin/sign-in");
    const card = page.locator("main > div");
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThanOrEqual(320);
  });

  test("storefront page still renders", async ({ page }) => {
    await page.goto("http://mama-ngozi.localhost:3000/");
    await expect(page.locator("h1")).toHaveText("Mama Ngozi African Market");
  });
});

test.describe("2FA enrollment (unenrolled admin)", () => {
  const UNENROLLED_EMAIL = "unenrolled-admin@platform.test";

  test("unenrolled admin is redirected to enroll-2fa, completes enrollment, reaches stores", async ({
    page,
  }) => {
    await page.goto("/admin/sign-in");
    await page.getByLabel("Email").fill(UNENROLLED_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.click("button[type='submit']");

    await page.waitForURL("**/admin/enroll-2fa", { timeout: 10000 });
    await expect(page.locator("h1")).toContainText("two-factor");

    await page.fill("input[type='password']", ADMIN_PASSWORD);
    await page.click("button:has-text('Begin setup')");

    const totpUriEl = page.locator("code").first();
    await expect(totpUriEl).toBeVisible({ timeout: 15000 });
    const totpUri = await totpUriEl.textContent();
    expect(totpUri).toBeTruthy();

    const secretMatch = totpUri!.match(/secret=([A-Z2-7]+)/i);
    expect(secretMatch).toBeTruthy();
    const enrolledSecret = secretMatch![1];

    const code = generateTOTP(enrolledSecret);
    await page.fill("input[inputmode='numeric']", code);
    await page.click("button:has-text('Verify and continue')");

    await page.waitForURL("**/admin/stores", { timeout: 15000 });
    await expect(page.locator("h1")).toHaveText("Stores");
  });
});
