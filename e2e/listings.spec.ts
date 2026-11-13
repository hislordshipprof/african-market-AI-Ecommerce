import { test, expect, type Page } from "@playwright/test";
import { findListingAuditLogs } from "./audit-db";
import { deleteE2eListings } from "./cleanup-listings";
import { findListingVariants, seedCartLine } from "./listing-db";
import { storeOwnerSignIn } from "./store-owner-auth";

const OWNER_EMAIL = "owner@mama-ngozi.test";
const LISTINGS_URL = "/store-admin/listings?store=mama-ngozi";

interface CreateListingOptions {
  name: string;
  /** Dollars, for example "8.50". Used for both the listing price and its variant price. */
  price: string;
  variantLabel?: string;
  weightG?: string;
  /** Quantity in stock (counted mode). */
  qty?: string;
}

/** Names of listings this file created, removed in afterAll (globalTeardown is the backstop). */
const createdNames: string[] = [];

/** Opens the create dialog, fills it, submits, and returns once the "Listing created" toast shows. */
async function createListingViaUI(page: Page, opts: CreateListingOptions) {
  createdNames.push(opts.name);
  await page.goto(LISTINGS_URL);
  await expect(page.locator("h1")).toHaveText("Products");

  await page.click("text=Add listing");
  await page.getByLabel("Product name").fill(opts.name);
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
  test.afterAll(async () => {
    await deleteE2eListings({ names: createdNames });
  });

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
    // The listing price follows the cheapest variant (#392 item 6).
    await page.getByLabel("Variant price in dollars").first().fill("7.00");
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

  test("an owner sets a listing's allergens and dietary claims, with an audit row", async ({ page }) => {
    const uniqueName = `E2E Attributes ${Date.now()}`;
    await createListingViaUI(page, { name: uniqueName, price: "4.00" });

    await page.goto(LISTINGS_URL);
    await page.getByRole("button", { name: `Ingredients and allergens for ${uniqueName}` }).click();
    const dialog = page.getByRole("dialog");
    const allergens = dialog.locator("section", { has: page.getByRole("heading", { name: "Allergens", exact: true }) });
    await expect(allergens.getByText("Unknown", { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(dialog.getByRole("button", { name: "Save attributes" })).toBeDisabled();

    await allergens.getByRole("switch").click();
    await allergens.getByRole("button", { name: "Peanuts" }).click();
    await allergens.getByRole("button", { name: "Sesame" }).click();
    const dietary = dialog.locator("section", { has: page.getByRole("heading", { name: "Dietary claims", exact: true }) });
    await dietary.getByRole("switch").click();
    await dietary.getByRole("button", { name: "Halal" }).click();
    await dialog.getByRole("button", { name: "Save attributes" }).click();
    await expect(page.getByText("Attributes saved")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: `Ingredients and allergens for ${uniqueName}` }).click();
    await expect(allergens.getByText("Set by you")).toBeVisible({ timeout: 10000 });
    await expect(allergens.getByRole("button", { name: "Peanuts" })).toHaveAttribute("aria-pressed", "true");
    await expect(allergens.getByRole("button", { name: "Milk" })).toHaveAttribute("aria-pressed", "false");
    const ingredients = dialog.locator("section", { has: page.getByRole("heading", { name: "Ingredients", exact: true }) });
    await expect(ingredients.getByText("Unknown", { exact: true })).toBeVisible();

    await expect
      .poll(async () => {
        const logs = await findListingAuditLogs("mama-ngozi", uniqueName);
        return logs.find((l) => l.action === "listing.attributes_correct") ?? null;
      }, { timeout: 10000 })
      .toMatchObject({
        actorEmail: OWNER_EMAIL,
        after: { allergensStatus: "known", allergens: ["peanuts", "sesame"], dietaryStatus: "known", dietaryClaims: ["halal"] },
      });

    await expect(ingredients.getByRole("button", { name: "Use catalog value" })).toHaveCount(0);
    await allergens.getByRole("button", { name: "Use catalog value" }).click();
    await dialog.getByRole("button", { name: "Save attributes" }).click();
    await expect(page.getByText("Attributes saved").last()).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: `Ingredients and allergens for ${uniqueName}` }).click();
    await expect(allergens.getByText("Unknown", { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(allergens.getByRole("button", { name: "Use catalog value" })).toHaveCount(0);
    await expect(dietary.getByText("Set by you")).toBeVisible();
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

  test("editing a carted listing keeps the variant id and the storefront shows the new variant price", async ({ page }) => {
    const uniqueName = `E2E Carted ${Date.now()}`;
    await createListingViaUI(page, {
      name: uniqueName,
      price: "8.00",
      variantLabel: "1kg",
      weightG: "1000",
    });

    const before = await findListingVariants("mama-ngozi", uniqueName);
    const variantId = before.variants[0]!.id;
    expect(before.variants[0]).toMatchObject({ price: 800, label: "1kg" });
    await seedCartLine("mama-ngozi", variantId);

    const detail = `/listings/${before.id}?store=mama-ngozi`;
    const product = page.getByTestId("product-detail");
    await page.goto(detail);
    await expect(product.getByLabel("$8.00").filter({ visible: true }).first()).toBeVisible({ timeout: 10000 });

    await page.goto(LISTINGS_URL);
    await page.locator(`[aria-label="Edit ${uniqueName}"]`).click();
    const dialog = page.getByRole("dialog", { name: "Edit listing" });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.locator("input[placeholder='Price']").fill("9.50");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("text=Listing updated")).toBeVisible({ timeout: 10000 });

    const after = await findListingVariants("mama-ngozi", uniqueName);
    expect(after.variants.map((variant) => variant.id)).toEqual([variantId]);
    expect(after.variants[0]).toMatchObject({ price: 950, weightG: 1000 });
    // The listing price follows the cheapest variant (#392 item 6).
    expect(after.price).toBe(950);

    await page.goto(detail);
    await expect(product.getByLabel("$9.50").filter({ visible: true }).first()).toBeVisible({ timeout: 10000 });
    await expect(product.getByLabel("$8.00")).toHaveCount(0);

    await page.goto(LISTINGS_URL);
    await page.locator(`[aria-label="Edit ${uniqueName}"]`).click();
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("text=Listing updated")).toBeVisible({ timeout: 10000 });

    const resaved = await findListingVariants("mama-ngozi", uniqueName);
    expect(resaved.variants.map((variant) => variant.id)).toEqual([variantId]);
    expect(resaved.variants[0]?.price).toBe(950);
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
