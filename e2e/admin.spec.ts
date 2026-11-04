import { storeUrl } from "./urls";
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

  test("create store form rejects all-digit slug", async ({ page }) => {
    await page.click("text=Create store");
    await page.getByLabel("Slug").fill("123");
    await page.getByLabel("Store name").fill("Digit Slug Test");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=not allowed")).toBeVisible();
  });

  test("create store form rejects localhost slug", async ({ page }) => {
    await page.click("text=Create store");
    await page.getByLabel("Slug").fill("localhost");
    await page.getByLabel("Store name").fill("Localhost Slug Test");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=not allowed")).toBeVisible();
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

  test("create store with zero prep time and delivery radius", async ({ page }) => {
    const slug = `e2e-zero-${Date.now()}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Zero Values");
    await page.getByLabel("Prep time (minutes)").fill("0");
    await page.getByLabel("Delivery radius (miles)").fill("0");
    await page.click("button[type='submit']:has-text('Create store')");

    await page.waitForURL("**/admin/stores", { timeout: 10000 });
    await expect(page.locator(`text=${slug}`)).toBeVisible();
  });

  test("create and then edit a store", async ({ page }) => {
    const slug = `e2e-edit-${Date.now()}`;
    const updatedName = `E2E Edited ${slug}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Test Store");
    await page.click("button[type='submit']:has-text('Create store')");

    await page.waitForURL("**/admin/stores", { timeout: 10000 });
    await expect(page.locator(`text=${slug}`)).toBeVisible();

    await page.locator(`tr:has-text("${slug}") a:has-text("Edit")`).click();
    await page.waitForURL(/\/admin\/stores\//, { timeout: 5000 });

    await page.getByLabel("Store name").fill(updatedName);
    await page.click("button[type='submit']:has-text('Save changes')");

    await page.waitForURL("**/admin/stores", { timeout: 10000 });
    const row = page.locator(`tr:has-text("${slug}")`);
    await expect(row.getByText(updatedName)).toBeVisible();
  });

  test("storefront is reachable after store creation", async ({ page }) => {
    const slug = `e2e-live-${Date.now()}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Live Store");
    await page.click("button[type='submit']:has-text('Create store')");
    await page.waitForURL("**/admin/stores", { timeout: 10000 });

    await page.goto(`${storeUrl(slug)}/`);
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

    await page.goto(`${storeUrl(slug)}/`);
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
    await page.goto(`${storeUrl("mama-ngozi")}/`);
    await expect(page.locator("h1")).toHaveText("Mama Ngozi African Market");
  });
});

test.describe("Catalog review (authenticated)", () => {
  // These tests all mutate the first review row. Parallel workers were approving
  // that row while another test was renaming it.
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ page }) => {
    await adminSignIn(page);
    await page.goto("/admin/catalog/review");
    await expect(page.locator("h1")).toHaveText("Catalog review", { timeout: 15000 });
  });

  test("approve moves product to active tab", async ({ page }) => {
    const reviewCountBefore = await page.locator("a[href*='status=needs_review'] span").last().textContent();
    const activeCountBefore = await page.locator("a[href*='status=active'] span").last().textContent();

    const firstRow = page.locator("table tbody tr").first();
    await firstRow.getByRole("button", { name: "Approve" }).click();

    await expect(page.locator("a[href*='status=needs_review'] span").last()).not.toHaveText(reviewCountBefore!, { timeout: 10000 });

    const reviewCountAfter = await page.locator("a[href*='status=needs_review'] span").last().textContent();
    const activeCountAfter = await page.locator("a[href*='status=active'] span").last().textContent();
    expect(Number(reviewCountAfter)).toBe(Number(reviewCountBefore) - 1);
    expect(Number(activeCountAfter)).toBe(Number(activeCountBefore) + 1);
  });

  test("edit-then-approve updates name and moves to active", async ({ page }) => {
    const activeCountBefore = await page.locator("a[href*='status=active'] span").last().textContent();

    const firstRow = page.locator("table tbody tr").first();
    await firstRow.getByRole("button", { name: "Edit" }).click();

    const modal = page.getByRole("heading", { name: "Edit product" });
    await expect(modal).toBeVisible({ timeout: 5000 });

    const nameInput = page.getByRole("dialog").locator("input").first();
    const editedName = `AAA-E2E-${Date.now()}`;
    await nameInput.fill(editedName);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    await page.reload();
    await expect(page.locator("h1")).toHaveText("Catalog review", { timeout: 15000 });

    const editedRow = page.locator("table tbody tr").filter({ hasText: editedName });
    await expect(editedRow).toBeVisible({ timeout: 10000 });
    await editedRow.getByRole("button", { name: "Approve" }).click();

    await expect(page.locator("a[href*='status=active'] span").last()).not.toHaveText(activeCountBefore!, { timeout: 10000 });
  });

  test("edit modal is an accessible dialog: role, aria-modal, focus trap, Escape", async ({ page }) => {
    await page.locator("table tbody tr").first().getByRole("button", { name: "Edit" }).click();

    const dialog = page.getByRole("dialog", { name: "Edit product" });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    // Focus moves into the dialog on open.
    await expect(dialog.locator(":focus")).toHaveCount(1);

    // Tab (and Shift+Tab) through more stops than the dialog has controls: focus must wrap inside it.
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press(key);
        const inside = await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']"));
        expect(inside, `${key} #${i + 1} left the dialog`).toBe(true);
      }
    }

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("reject moves product to rejected tab", async ({ page }) => {
    const rejectedCountBefore = await page.locator("a[href*='status=rejected'] span").last().textContent();

    const firstRow = page.locator("table tbody tr").first();
    await firstRow.getByRole("button", { name: "Reject" }).click();

    await expect(page.locator("a[href*='status=rejected'] span").last()).not.toHaveText(rejectedCountBefore!, { timeout: 10000 });

    const rejectedCountAfter = await page.locator("a[href*='status=rejected'] span").last().textContent();
    expect(Number(rejectedCountAfter)).toBe(Number(rejectedCountBefore) + 1);
  });

  test("non-admin access to catalog review redirects to sign-in", async ({ browser }) => {
    const context = await browser.newContext();
    const freshPage = await context.newPage();
    await freshPage.goto(`${storeUrl()}/admin/catalog/review`);
    await expect(freshPage).toHaveURL(/\/admin\/sign-in/, { timeout: 10000 });
    await context.close();
  });
});

test.describe("Catalog review screenshots", () => {
  test("desktop 1440px light and dark", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await adminSignIn(page);
    await page.goto("/admin/catalog/review");
    await expect(page.locator("h1")).toHaveText("Catalog review", { timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: "screenshots/review-1440px-light.png", fullPage: true });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForTimeout(500);
    await page.screenshot({ path: "screenshots/review-1440px-dark.png", fullPage: true });
    await context.close();
  });

  test("mobile 390px light and dark", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await adminSignIn(page);
    await page.goto("/admin/catalog/review");
    await expect(page.locator("h1")).toHaveText("Catalog review", { timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: "screenshots/review-390px-light.png", fullPage: true });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForTimeout(500);
    await page.screenshot({ path: "screenshots/review-390px-dark.png", fullPage: true });
    await context.close();
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

test("the store form timezone control uses the input and destructive tokens", async ({ page }) => {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").fill(generateTotpCode());
  await page.click("button[type='submit']");
  await page.waitForURL("**/admin/stores");
  await page.goto("/admin/stores/new");

  const border = await page.locator("#timezone").evaluate((el) => {
    const probe = document.createElement("div");
    probe.style.borderColor = getComputedStyle(document.documentElement).getPropertyValue("--input");
    document.body.append(probe);
    const expected = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return { actual: getComputedStyle(el).borderTopColor, expected };
  });
  expect(border.actual).toBe(border.expected);

  await page.locator("#timezone").evaluate((el: HTMLSelectElement) => {
    const option = document.createElement("option");
    option.value = "Not/AZone";
    option.text = "Not/AZone";
    el.append(option);
    el.value = "Not/AZone";
  });
  await page.locator("#slug").fill(`token-${Date.now()}`);
  await page.locator("#storeName").fill("Token Check");
  await page.locator("button[type='submit']").click();
  const error = page.locator("p", { hasText: "Invalid timezone" });
  await expect(error).toBeVisible();
  const destructive = await error.evaluate((el) => {
    const probe = document.createElement("div");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--destructive");
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(el).color, expected };
  });
  expect(destructive.actual).toBe(destructive.expected);
});
