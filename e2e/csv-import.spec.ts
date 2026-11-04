import { test, expect, type Page } from "@playwright/test";
import { generateTOTP } from "./totp";
import { deleteE2eListings } from "./cleanup-listings";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const OWNER_EMAIL = "owner@mama-ngozi.test";
const OWNER_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET =
  process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const IMPORT_URL = "/store-admin/listings/import?store=mama-ngozi";

// Production host (override disabled): src/proxy.test.ts
// "ignores ?store= param in production" and "still resolves slug from host".
// E2E always sets E2E_STORE_OVERRIDE, so it cannot run that case.
// The links above still carry ?store= from the session slug on every host.

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

function writeTempBytes(name: string, bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-import-e2e-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
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
    // Proxy strips ?store= before render. Links still use the session slug.
    await expect(page).not.toHaveURL(/[?&]store=/);
    await expect(page.locator("h1")).toHaveText("Import listings");
    await expect(
      page.getByText(
        "Upload a CSV file to add listings to Mama Ngozi African Market.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Products" })).toHaveAttribute(
      "href",
      "/store-admin/listings?store=mama-ngozi",
    );
    await expect(page.getByText("Upload CSV")).toBeVisible();
    await expect(page.getByText("Upload & Preview")).toBeVisible();
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/\(s\)/);
    expect(text).not.toMatch(/Import Products/);
  });

  test("import link visible from listings page", async ({ page }) => {
    await page.goto("/store-admin/listings?store=mama-ngozi");
    await expect(page.getByRole("link", { name: "Import CSV" })).toHaveAttribute(
      "href",
      "/store-admin/listings/import?store=mama-ngozi",
    );
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

    await expect(page.getByText("New listings", { exact: true })).toBeVisible({
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

    await expect(page.getByText("New listings", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(nameA)).toBeVisible();
    await expect(page.getByText(nameB)).toBeVisible();

    await page.getByRole("button", { name: "Import 2 listings" }).click();

    await expect(page.getByText("Import Complete")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("Imported 2 listings successfully")).toBeVisible();

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const nav = page.waitForRequest((req) => {
      const url = new URL(req.url());
      return (
        url.pathname === "/store-admin/listings" &&
        url.searchParams.get("store") === "mama-ngozi"
      );
    });
    await page.getByRole("button", { name: "Go to Products" }).evaluate((el) => {
      const button = el as HTMLButtonElement;
      button.click();
      button.click();
    });
    const request = await nav;
    expect(new URL(request.url()).searchParams.get("store")).toBe("mama-ngozi");
    await expect(page).toHaveURL(/\/store-admin\/listings$/);
    await expect(page.locator(`text=${nameA}`)).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`text=${nameB}`)).toBeVisible();
    expect(pageErrors).toEqual([]);
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

    const errorsTitle = page.locator("[data-slot='card-title']").filter({ hasText: /^Errors$/ });
    await expect(errorsTitle.locator("svg")).toHaveClass(/text-destructive/);

    const errorsSummary = page.locator("div.flex.items-center").filter({
      has: page.locator("p", { hasText: /^Errors$/ }),
    });
    await expect(errorsSummary.locator("svg")).toHaveClass(/text-destructive/);

    const errorCard = page.locator("[data-slot='card']").filter({
      has: page.locator("[data-slot='card-title']", { hasText: /^Errors$/ }),
    });
    const names = errorCard.locator("p.truncate");
    expect(await names.count()).toBeGreaterThan(0);
    for (let i = 0; i < (await names.count()); i++) {
      await expect(names.nth(i)).toHaveClass(/text-destructive/);
      await expect(names.nth(i)).not.toHaveText("");
    }
    const reasons = errorCard.locator("[data-slot='card-content'] p.text-xs");
    expect(await reasons.count()).toBeGreaterThan(0);
    for (let i = 0; i < (await reasons.count()); i++) {
      await expect(reasons.nth(i)).toHaveClass(/text-destructive/);
      await expect(reasons.nth(i).locator("svg")).toHaveClass(/text-destructive/);
    }

    await expect(page.locator("[class*='--color-deal']")).toHaveCount(1);
    const ambiguousSummary = page.locator("div.flex.items-center").filter({
      has: page.locator("p", { hasText: /^Ambiguous$/ }),
    });
    await expect(ambiguousSummary.locator("svg")).toHaveClass(/--color-deal/);
  });

  test("N14: a PNG upload tells the owner to save a UTF-8 CSV", async ({ page }) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const filePath = writeTempBytes("photo.png", png);

    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(filePath);
    await page.click("text=Upload & Preview");

    await expect(
      page.getByText("This does not look like a CSV file. Save it as CSV (UTF-8) and upload it again."),
    ).toBeVisible({ timeout: 15000 });
  });

  test("empty file shows error", async ({ page }) => {
    const csvPath = writeTempCsv("");

    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(csvPath);
    await page.click("text=Upload & Preview");

    await expect(
      page.getByText(/select a CSV file|empty|Could not parse/i),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator("[data-slot='card-title']").filter({ hasText: /^Errors$/ }),
    ).toHaveCount(0);
  });

  test("B4: ambiguous row resolution via radio buttons", async ({ page }) => {
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    const ts = Date.now();

    // Create master products inside a platform admin transaction (master_products has FORCE RLS)
    const [, , mpAlpha] = await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.masterProduct.create({
        data: { name: `E2E Ambig Alpha ${ts}`, frozen: false, perishable: false, status: "active" },
      }),
    ]);
    const [, , mpBeta] = await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.masterProduct.create({
        data: { name: `E2E Ambig Beta ${ts}`, frozen: false, perishable: true, status: "active" },
      }),
    ]);
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.productSynonym.createMany({
        data: [
          { productId: mpAlpha.id, term: `e2e ambig thing ${ts}` },
          { productId: mpBeta.id, term: `e2e ambig thing ${ts}` },
        ],
      }),
    ]);

    const listingName = `E2E Ambig Thing ${ts}`;
    createdNames.push(listingName);

    const csvPath = writeTempCsv(`name,price\n${listingName},6.25\n`);

    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(csvPath);
    await page.click("text=Upload & Preview");

    await expect(page.getByText("Ambiguous Matches")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(listingName)).toBeVisible();
    await expect(
      page.getByText("Matches 2 master products — select one:"),
    ).toBeVisible();

    // Select the Beta candidate via its radio button label
    await page.locator(`label:has-text("E2E Ambig Beta ${ts}")`).click();

    await page.getByRole("button", { name: "Import 1 listing" }).click();

    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 15000 });

    // Verify the listing was created with the chosen master product (listings has FORCE RLS)
    const store = await prisma.store.findUnique({ where: { slug: "mama-ngozi" } });
    const [, , listing] = await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.store_id', ${store!.id}, true)`,
      prisma.listing.findFirst({
        where: { storeId: store!.id, masterProductId: mpBeta.id },
      }),
    ]);
    expect(listing).toBeTruthy();
    expect(listing!.perishable).toBe(true);

    // Cleanup test master products (inside platform admin transaction for RLS)
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.productSynonym.deleteMany({
        where: { productId: { in: [mpAlpha.id, mpBeta.id] } },
      }),
      prisma.masterProduct.deleteMany({
        where: { id: { in: [mpAlpha.id, mpBeta.id] } },
      }),
    ]);
    await prisma.$disconnect();
  });

  test("B5: file over 2 MB shows size error", async ({ page }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-import-b5-"));
    const bigPath = path.join(dir, "big.csv");
    const header = "name,price\n";
    const rowLine = "A".repeat(200) + ",9.99\n";
    const rowCount = Math.ceil((2.1 * 1024 * 1024) / rowLine.length);
    const fd = fs.openSync(bigPath, "w");
    fs.writeSync(fd, header);
    for (let i = 0; i < rowCount; i++) fs.writeSync(fd, rowLine);
    fs.closeSync(fd);

    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(bigPath);
    await page.click("text=Upload & Preview");

    await expect(
      page.getByText("File exceeds the maximum size of 2 MB"),
    ).toBeVisible({ timeout: 10000 });
  });

  test("junk store param does not replace the session slug", async ({ page }) => {
    await page.goto("/store-admin/listings/import?store=Not_Routable!");
    await expect(page).toHaveURL(/Not_Routable/);
    await expect(page.locator("h1")).toHaveText("Import listings");
    await expect(page.getByRole("link", { name: "Products" })).toHaveAttribute(
      "href",
      "/store-admin/listings?store=mama-ngozi",
    );
  });

  test("another store's import URL signs the owner out of this screen", async ({ page }) => {
    const locations: string[] = [];
    page.on("response", (response) => {
      const location = response.headers()["location"];
      if (location) locations.push(location);
    });

    await page.goto("/store-admin/listings/import?store=tante-marie");
    await expect(page).toHaveURL(/\/store-admin\/sign-in/);
    await expect(page.getByRole("heading", { name: "Import listings" })).toHaveCount(0);
    await expect(page.locator("a[href*='mama-ngozi']")).toHaveCount(0);
    expect(locations.some((location) => location.includes("store=tante-marie"))).toBe(true);
    expect(locations.some((location) => location.includes("/store-admin/sign-in"))).toBe(true);
  });

  test("commit button pluralises and the toast drops the parenthetical", async ({ page }) => {
    const ts = Date.now();
    const nameA = `E2E Plural ${ts} A`;
    const nameB = `E2E Plural ${ts} B`;
    createdNames.push(nameA, nameB);
    const csvPath = writeTempCsv(`name,price\n${nameA},4.00\n${nameB},5.00\n`);

    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(csvPath);
    await page.click("text=Upload & Preview");
    await expect(page.getByRole("button", { name: "Import 2 listings" })).toBeEnabled({
      timeout: 15000,
    });

    await page.getByRole("button", { name: "Deselect all" }).click();
    const none = page.getByRole("button", { name: "Import 0 listings" });
    await expect(none).toBeVisible();
    await expect(none).toBeDisabled();

    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Import 1 listing" }).click();
    await expect(page.locator("[data-sonner-toast]")).toContainText("Imported 1 listing.", {
      timeout: 15000,
    });
    await expect(page.getByText("Imported 1 listing successfully")).toBeVisible();
  });

  test("matched, new and already-listed copy uses listing", async ({ page }) => {
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    const ts = Date.now();
    const matchName = `E2E Match Grain ${ts}`;
    const newName = `E2E New Spice ${ts}`;
    try {
      await prisma.$transaction([
        prisma.$executeRaw`SET LOCAL ROLE app_user`,
        prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        prisma.masterProduct.create({
          data: { name: matchName, frozen: false, perishable: false, status: "active" },
        }),
      ]);

      const csvPath = writeTempCsv(
        `name,price\nEgusi (Melon Seeds),4.50\n${matchName},3.25\n${newName},2.00\n`,
      );
      await page.goto(IMPORT_URL);
      await page.locator("input[type='file']").setInputFiles(csvPath);
      await page.click("text=Upload & Preview");

      await expect(page.getByText("Matched listings", { exact: true })).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByText("New listings", { exact: true })).toBeVisible();
      await expect(
        page.getByText("Already listed in your store. These rows will be skipped."),
      ).toBeVisible();
      await expect(page.getByText("These CSV rows matched a master product.")).toBeVisible();
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/\(s\)/);
      expect(text).not.toMatch(/Import Products/);
    } finally {
      await prisma.$transaction([
        prisma.$executeRaw`SET LOCAL ROLE app_user`,
        prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        prisma.masterProduct.deleteMany({ where: { name: matchName } }),
      ]);
      await prisma.$disconnect();
    }
  });

  test("every invalid row stays a toast and does not open the Errors section", async ({ page }) => {
    const csvPath = writeTempCsv("name,price\n,3.00\nBad Price,abc\n");
    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(csvPath);
    await page.click("text=Upload & Preview");
    await expect(page.getByText("Missing required field: name")).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator("[data-slot='card-title']").filter({ hasText: /^Errors$/ }),
    ).toHaveCount(0);
  });

  test("five thousand selected listings fit a 360px viewport", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 360, height: 800 });
    const lines = ["name,price"];
    for (let i = 1; i <= 5000; i++) lines.push(`E2E Max ${i},1.00`);
    const csvPath = writeTempCsv(`${lines.join("\n")}\n`);

    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(csvPath);
    await page.click("text=Upload & Preview");
    const commit = page.getByRole("button", { name: "Import 5000 listings" });
    await expect(commit).toBeVisible({ timeout: 120_000 });
    await commit.scrollIntoViewIfNeeded();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    expect(fits).toBe(true);
  });
});
