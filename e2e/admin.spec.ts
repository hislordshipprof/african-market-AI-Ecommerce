import { test, expect } from "@playwright/test";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

function generateTotpCode(): string {
  return generateTOTP(SEED_TOTP_SECRET);
}

async function adminSignIn(page: import("@playwright/test").Page) {
  const apiResponses: string[] = [];
  page.on("response", (resp) => {
    if (resp.url().includes("/api/auth/")) {
      apiResponses.push(`${resp.status()} ${resp.url()}`);
    }
  });

  await page.goto("/admin/sign-in");
  await page.fill("input[type='email']", ADMIN_EMAIL);
  await page.fill("input[type='password']", ADMIN_PASSWORD);

  const [signInResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/") && r.request().method() === "POST", { timeout: 15000 }),
    page.click("button[type='submit']"),
  ]);

  const signInBody = await signInResp.text().catch(() => "(unreadable)");
  const signInStatus = signInResp.status();

  const errorEl = page.locator(".bg-red-50");
  const totpEl = page.locator("text=Enter the 6-digit code");

  const winner = await Promise.race([
    totpEl.waitFor({ state: "visible", timeout: 10000 }).then(() => "totp" as const),
    errorEl.waitFor({ state: "visible", timeout: 10000 }).then(() => "error" as const),
    page.waitForURL("**/admin/stores", { timeout: 10000 }).then(() => "stores" as const),
  ]).catch(() => "timeout" as const);

  if (winner === "error") {
    const errText = await errorEl.textContent();
    throw new Error(`Sign-in failed with error: "${errText}" | API ${signInStatus}: ${signInBody} | responses: ${apiResponses.join(", ")}`);
  }

  if (winner === "timeout") {
    const bodyText = await page.locator("body").textContent().catch(() => "(unreadable)");
    throw new Error(`Sign-in timed out (no TOTP, no error, no redirect) | page URL: ${page.url()} | API ${signInStatus}: ${signInBody} | body: ${bodyText?.slice(0, 500)} | responses: ${apiResponses.join(", ")}`);
  }

  if (winner === "totp") {
    const code = generateTotpCode();
    await page.fill("input[inputmode='numeric']", code);

    const [verifyResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/") && r.request().method() === "POST", { timeout: 15000 }),
      page.click("button[type='submit']"),
    ]);

    const verifyBody = await verifyResp.text().catch(() => "(unreadable)");
    const verifyStatus = verifyResp.status();

    const postTotpWinner = await Promise.race([
      page.waitForURL("**/admin/stores", { timeout: 15000 }).then(() => "stores" as const),
      errorEl.waitFor({ state: "visible", timeout: 15000 }).then(() => "error" as const),
    ]).catch(() => "timeout" as const);

    if (postTotpWinner === "error") {
      const errText = await errorEl.textContent();
      throw new Error(`TOTP verification failed: "${errText}" | API ${verifyStatus}: ${verifyBody}`);
    }

    if (postTotpWinner === "timeout") {
      throw new Error(`Post-TOTP redirect timed out | page URL: ${page.url()} | API ${verifyStatus}: ${verifyBody}`);
    }
  }
}

test.describe("Platform admin console", () => {
  test("sign-in page renders email and password fields", async ({ page }) => {
    await page.goto("/admin/sign-in");
    await expect(page.locator("h1")).toHaveText("Platform Admin");
    await expect(page.locator("input[type='email']")).toBeVisible();
    await expect(page.locator("input[type='password']")).toBeVisible();
    await expect(page.locator("button[type='submit']")).toHaveText("Sign in");
  });

  test("unauthenticated access to /admin redirects to sign-in", async ({
    page,
  }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/sign-in/);
  });

  test("unauthenticated access to /admin/stores redirects to sign-in", async ({
    page,
  }) => {
    await page.goto("/admin/stores");
    await expect(page).toHaveURL(/\/admin\/sign-in/);
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

    await page.fill("input[name='slug']", "mama-ngozi");
    await page.fill("input[name='name']", "Duplicate Test");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=already exists")).toBeVisible();
  });

  test("create store form rejects reserved slug", async ({ page }) => {
    await page.click("text=Create store");
    await page.fill("input[name='slug']", "admin");
    await page.fill("input[name='name']", "Reserved Slug Test");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=reserved")).toBeVisible();
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

test.describe("2FA enrollment (unenrolled admin)", () => {
  const UNENROLLED_EMAIL = "unenrolled-admin@platform.test";

  test("unenrolled admin is redirected to enroll-2fa, completes enrollment, reaches stores", async ({
    page,
  }) => {
    await page.goto("/admin/sign-in");
    await page.fill("input[type='email']", UNENROLLED_EMAIL);
    await page.fill("input[type='password']", ADMIN_PASSWORD);
    await page.click("button[type='submit']");

    await page.waitForURL("**/admin/enroll-2fa", { timeout: 10000 });
    await expect(page.locator("h1")).toContainText("two-factor");

    await page.fill("input[type='password']", ADMIN_PASSWORD);
    await page.click("button:has-text('Begin setup')");

    await expect(page.locator("text=Scan this URI")).toBeVisible({
      timeout: 10000,
    });

    const totpUriEl = page.locator("code").first();
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
