import { test, expect, type Page } from "@playwright/test";
import { generateTOTP } from "./totp";
import { findListingAuditLogs } from "./audit-db";

const OWNER_EMAIL = "owner@mama-ngozi.test";
const OWNER_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const LISTINGS_URL = "/store-admin/listings?store=mama-ngozi";

async function storeOwnerSignIn(page: Page) {
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

interface CreateListingOptions {
  name: string;
  /** Dollars, for example "8.50". Used for both the listing price and its variant price. */
  price: string;
  variantLabel?: string;
  weightG?: string;
  /** Quantity in stock (counted mode). */
  qty?: string;
}

/** Opens the create dialog, fills it, submits, and returns once the "Listing created" toast shows. */
async function createListingViaUI(page: Page, opts: CreateListingOptions) {
  await page.goto(LISTINGS_URL);
  await expect(page.locator("h1")).toHaveText("Products");

  await page.click("text=Add listing");
  await page.getByLabel("Product name").fill(opts.name);
  await page.getByLabel("Price ($)").fill(opts.price);
  if (opts.qty !== undefined) await page.getByLabel("Quantity in stock").fill(opts.qty);

  await page
    .locator("input[placeholder='Label (e.g. 1kg)']")
    .first()
    .fill(opts.variantLabel ?? "1kg");
  await page.locator("input[placeholder='Price']").first().fill(opts.price);
  await page
    .locator("input[placeholder='Weight (g)']")
    .first()
    .fill(opts.weightG ?? "1000");

  await page.click("text=Create listing");
  await expect(page.locator("text=Listing created")).toBeVisible({ timeout: 10000 });
}

/** The row for one listing, found by name inside the whole page. */
function listingRow(page: Page, name: string) {
  return page.locator("div.py-3", { hasText: name });
}

function section(page: Page, title: string) {
  return page
    .locator("[data-slot='card']")
    .filter({ has: page.getByText(title, { exact: true }) });
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

  test("master product picker searches server-side and stays bounded", async ({ page }) => {
    await page.goto(LISTINGS_URL);
    await page.click("text=Add listing");
    const picker = page.getByLabel("Master product (optional)");
    await picker.click();
    await expect(page.getByRole("option").first()).toBeVisible({ timeout: 10000 });
    expect(await page.getByRole("option").count()).toBeLessThanOrEqual(50);

    await picker.fill("zzzznotfound");
    await expect(page.getByText("No catalog product matches")).toBeVisible({ timeout: 10000 });

    await picker.fill("");
    await expect(page.getByRole("option").first()).toBeVisible({ timeout: 10000 });
  });

  test("create a listing with a variant", async ({ page }) => {
    await createListingViaUI(page, {
      name: `E2E Garri ${Date.now()}`,
      price: "8.50",
      variantLabel: "1kg",
      weightG: "1000",
    });
  });

  test("edit price and verify audit trail exists", async ({ page }) => {
    const uniqueName = `E2E Audit ${Date.now()}`;
    await createListingViaUI(page, {
      name: uniqueName,
      price: "5.00",
      variantLabel: "500g",
      weightG: "500",
    });

    await page.goto(LISTINGS_URL);
    await expect(page.locator(`text=${uniqueName}`)).toBeVisible({ timeout: 10000 });

    await page.locator(`[aria-label="Edit ${uniqueName}"]`).click();
    await expect(page.locator("text=Edit listing")).toBeVisible({ timeout: 5000 });
    await page.getByLabel("Price ($)").fill("7.00");
    await page.click("text=Save changes");
    await expect(page.locator("text=Listing updated")).toBeVisible({ timeout: 10000 });

    // The audit row is read from the database and must record the 500 -> 700 cents change.
    await expect
      .poll(
        async () => {
          const logs = await findListingAuditLogs("mama-ngozi", uniqueName);
          return logs.find((l) => l.action === "listing.price_change") ?? null;
        },
        { timeout: 10000 },
      )
      .toMatchObject({
        entityType: "listing",
        actorEmail: OWNER_EMAIL,
        before: { price: 500 },
        after: { price: 700 },
      });

    await page.goto(LISTINGS_URL);
    await expect(listingRow(page, uniqueName).getByText("$7.00")).toBeVisible({ timeout: 5000 });
  });

  test("switch stock mode from counted to status", async ({ page }) => {
    const uniqueName = `E2E Mode ${Date.now()}`;
    await createListingViaUI(page, {
      name: uniqueName,
      price: "3.00",
      qty: "10",
      variantLabel: "250g",
      weightG: "250",
    });

    await page.goto(LISTINGS_URL);
    await expect(page.locator(`text=${uniqueName}`)).toBeVisible({ timeout: 10000 });
    await expect(listingRow(page, uniqueName).getByText("10 in stock")).toBeVisible();

    await page.locator(`[aria-label="Edit ${uniqueName}"]`).click();
    await expect(page.locator("text=Edit listing")).toBeVisible({ timeout: 5000 });
    await page.locator("button:has-text('Counted')").click();
    await page.locator("[role='option']:has-text('Status')").click();
    await page.click("text=Save changes");
    await expect(page.locator("text=Listing updated")).toBeVisible({ timeout: 10000 });

    // The row's stock badge changes from a count to the status label.
    await page.goto(LISTINGS_URL);
    const row = listingRow(page, uniqueName);
    await expect(row.getByText("In stock", { exact: true })).toBeVisible();
    await expect(row.getByText("10 in stock")).toHaveCount(0);
  });

  test("deactivate listing excludes it from active list", async ({ page }) => {
    const uniqueName = `E2E Deactivate ${Date.now()}`;
    await createListingViaUI(page, { name: uniqueName, price: "4.00" });

    await page.goto(LISTINGS_URL);
    await expect(page.locator(`text=${uniqueName}`)).toBeVisible({ timeout: 10000 });

    await page.locator(`[aria-label="Deactivate ${uniqueName}"]`).click();
    await expect(page.locator("text=Listing deactivated")).toBeVisible({ timeout: 10000 });

    await page.goto(LISTINGS_URL);
    await expect(section(page, "Inactive listings").getByText(uniqueName)).toBeVisible({
      timeout: 5000,
    });
    await expect(section(page, "Active listings").getByText(uniqueName)).toHaveCount(0);
  });
});
