import { test, expect, type Page } from "@playwright/test";
import { generateTOTP } from "./totp";
import { deleteE2eListings } from "./cleanup-listings";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const OWNER_EMAIL = "owner@mama-ngozi.test";
const OWNER_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET =
  process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const IMPORT_URL = "/store-admin/listings/import?store=mama-ngozi";

async function storeOwnerSignIn(page: Page) {
  await page.goto("/store-admin/sign-in?store=mama-ngozi");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.click("button[type='submit']");

  await page
    .getByLabel("Verification code")
    .waitFor({ state: "visible", timeout: 10000 });
  const code = generateTOTP(SEED_TOTP_SECRET);
  await page.getByLabel("Verification code").fill(code);
  await page.click("button[type='submit']");

  try {
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith("/store-admin") &&
        !url.pathname.includes("sign-in"),
      { timeout: 15000 },
    );
  } catch {
    const url = page.url();
    const body = await page
      .locator("body")
      .textContent()
      .catch(() => "");
    throw new Error(
      `Store owner sign-in failed | url: ${url} | body: ${body?.slice(0, 300)}`,
    );
  }
}

const createdNames: string[] = [];

function writeTempCsv(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-import-e2e-"));
  const filePath = path.join(dir, "import.csv");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

test.describe("CSV import (unauthenticated)", () => {
  test("redirects to sign-in", async ({ page }) => {
    const response = await page.goto(IMPORT_URL);
    expect(response?.status()).not.toBe(500);
    const url = page.url();
    expect(/sign-in/.test(url)).toBe(true);
  });
});

test.describe("CSV import (authenticated)", () => {
  test.afterAll(async () => {
    if (createdNames.length > 0) {
      await deleteE2eListings({ names: createdNames });
    }
  });

  test.beforeEach(async ({ page }) => {
    await storeOwnerSignIn(page);
  });

  test("upload page renders with drop zone", async ({ page }) => {
    await page.goto(IMPORT_URL);
    await expect(page.locator("h1")).toHaveText("Import Products");
    await expect(page.getByText("Upload CSV")).toBeVisible();
    await expect(page.getByText("Upload & Preview")).toBeVisible();
  });

  test("import link visible from listings page", async ({ page }) => {
    await page.goto("/store-admin/listings?store=mama-ngozi");
    await expect(page.getByText("Import CSV")).toBeVisible();
  });

  test("upload a valid CSV and see preview", async ({ page }) => {
    const csvPath = writeTempCsv(
      "name,price\nE2E Import Widget A,9.99\nE2E Import Widget B,14.50\n",
    );
    createdNames.push("E2E Import Widget A", "E2E Import Widget B");

    await page.goto(IMPORT_URL);

    const fileInput = page.locator("input[type='file']");
    await fileInput.setInputFiles(csvPath);
    await expect(page.getByText("import.csv")).toBeVisible();

    await page.click("text=Upload & Preview");

    await expect(page.getByText("New Products")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("E2E Import Widget A")).toBeVisible();
    await expect(page.getByText("E2E Import Widget B")).toBeVisible();
  });

  test("import new products and see success", async ({ page }) => {
    const ts = Date.now();
    const nameA = `E2E Csv Import ${ts} A`;
    const nameB = `E2E Csv Import ${ts} B`;
    createdNames.push(nameA, nameB);

    const csvPath = writeTempCsv(
      `name,price\n${nameA},5.00\n${nameB},7.50\n`,
    );

    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(csvPath);
    await page.click("text=Upload & Preview");

    await expect(page.getByText("New Products")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(nameA)).toBeVisible();
    await expect(page.getByText(nameB)).toBeVisible();

    await page.click("text=Import 2 product(s)");

    await expect(page.getByText("Import Complete")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("Imported 2 listings successfully")).toBeVisible();

    await page.click("text=Go to Products");
    await expect(page.locator(`text=${nameA}`)).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`text=${nameB}`)).toBeVisible();
  });

  test("CSV with errors shows error section", async ({ page }) => {
    const csvPath = writeTempCsv(
      "name,price\nGood Product,5.00\n,3.00\nBad Price,abc\n",
    );
    createdNames.push("Good Product");

    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(csvPath);
    await page.click("text=Upload & Preview");

    await expect(page.getByText("Missing required field: name")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Invalid price")).toBeVisible();
  });

  test("empty file shows error", async ({ page }) => {
    const csvPath = writeTempCsv("");

    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(csvPath);
    await page.click("text=Upload & Preview");

    await expect(
      page.getByText(/select a CSV file|empty|Could not parse/i),
    ).toBeVisible({ timeout: 10000 });
  });
});
