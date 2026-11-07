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

function importSuccessPanel(page: Page) {
  return page
    .getByRole("heading", { name: "Import Complete" })
    .locator("..")
    .getByText("Imported 1 listing successfully");
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

    await page.getByRole("button", { name: "Import More" }).click();
    const moreName = `E2E More Custom ${ts}`;
    createdNames.push(moreName);
    await page.locator("input[type='file']").setInputFiles(
      writeTempCsv(`name,price\n${moreName},3.50\n`),
    );
    await page.click("text=Upload & Preview");
    const moreButton = page.getByRole("button", { name: "Import 1 listing" });
    await expect(moreButton).toBeVisible({ timeout: 15000 });
    await moreButton.click();
    await expect(importSuccessPanel(page)).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "Import More" }).click();
    await page.locator("input[type='file']").setInputFiles(csvPath);
    await page.click("text=Upload & Preview");
    await expect(page.getByText("Ambiguous Matches")).toBeVisible({ timeout: 15000 });
    await page.locator(`label:has-text("E2E Ambig Beta ${ts}")`).click();
    await page.getByRole("button", { name: "Back" }).click();
    const backName = `E2E Back Custom ${ts}`;
    createdNames.push(backName);
    await page.locator("input[type='file']").setInputFiles(
      writeTempCsv(`name,price\n${backName},2.25\n`),
    );
    await page.click("text=Upload & Preview");
    const backButton = page.getByRole("button", { name: "Import 1 listing" });
    await expect(backButton).toBeVisible({ timeout: 15000 });
    await backButton.click();
    await expect(importSuccessPanel(page)).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "Import More" }).click();
    const windows1252 = Buffer.concat([
      Buffer.from("name,price\n"),
      Buffer.from([0x42, 0xee, 0x6d, 0x62, 0x61]),
      Buffer.from(",5.00\n"),
    ]);
    await page.locator("input[type='file']").setInputFiles(
      writeTempBytes("windows.csv", windows1252),
    );
    await page.click("text=Upload & Preview");
    await expect(page.getByText("not saved as UTF-8")).toBeVisible({ timeout: 15000 });
    const recovered = `E2E Utf8 ${ts}`;
    createdNames.push(recovered);
    await page.locator("input[type='file']").setInputFiles(
      writeTempCsv(`name,price\n${recovered},4.00\n`),
    );
    await page.click("text=Upload & Preview");
    await expect(page.getByText(recovered)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Import 1 listing" })).toBeVisible();

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

  test("exactly 2 MB CSV previews through the production Server Action", async ({ page }) => {
    test.setTimeout(90_000);
    const name = `E2E Exact ${Date.now()}`;
    const target = 2_097_152;
    const header = "name,price,notes\n";
    const prefix = `${name},9.99,`;
    const suffix = "\n";
    const pad = target - Buffer.byteLength(`${header}${prefix}${suffix}`);
    const csv = Buffer.from(`${header}${prefix}${"n".repeat(pad)}${suffix}`);
    expect(csv.length).toBe(target);
    const csvPath = writeTempBytes("exact-2mb.csv", csv);
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    try {
      await page.goto(IMPORT_URL);
      await page.locator("input[type='file']").setInputFiles(csvPath);
      await page.click("text=Upload & Preview");
      await expect(page.getByText("File exceeds the maximum size of 2 MB")).toHaveCount(0);
      await expect(page.getByText(/Body exceeded|Request Entity Too Large/)).toHaveCount(0);
      await expect(page.getByText("New listings", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(name)).toBeVisible();
      await expect(page.getByText(/Unknown columns ignored:\s*notes/)).toBeVisible();
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.listingImport.deleteMany({ where: { csvText: { contains: name } } });
      });
      await prisma.$disconnect();
    }
  });

  test("a lost commit response can be pressed again without importing twice", async ({ page }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const skipped = `E2E Lost Skip ${stamp}`;
    const keptAside = `E2E Lost Aside ${stamp}`;
    const shared = `E2E Lost Shared ${stamp}`;
    const alphaName = `E2E Lost Alpha ${stamp}`;
    const betaName = `E2E Lost Beta ${stamp}`;
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    let betaId = "";
    let alphaId = "";
    try {
      const products = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        const alpha = await tx.masterProduct.create({
          data: { name: alphaName, status: "active", frozen: false, perishable: false },
        });
        const beta = await tx.masterProduct.create({
          data: { name: betaName, status: "active", frozen: false, perishable: false },
        });
        await tx.productSynonym.create({ data: { productId: alpha.id, term: shared } });
        await tx.productSynonym.create({ data: { productId: beta.id, term: shared } });
        return { alpha, beta };
      });
      alphaId = products.alpha.id;
      betaId = products.beta.id;

      const csvPath = writeTempCsv(
        `name,price,qty\n${skipped},2.00,1\n${keptAside},1.00,4\n${shared},3.00,6\n`,
      );
      await test.step("preview", async () => {
        await page.goto(IMPORT_URL);
        await page.locator("input[type='file']").setInputFiles(csvPath);
        await page.click("text=Upload & Preview");
        await expect(page.getByText("Ambiguous Matches", { exact: true })).toBeVisible({ timeout: 20_000 });
      });
      const boxes = page.getByRole("checkbox");
      await test.step("choose the non-default rows", async () => {
        await expect(boxes).toHaveCount(2);
        await boxes.nth(0).uncheck();
        await boxes.nth(1).uncheck();
        await page.getByRole("radio", { name: betaName }).check();
        await expect(page.getByRole("button", { name: "Import 1 listing" })).toBeEnabled();
      });

      let firstBody: Buffer | null = null;
      let secondBody: Buffer | null = null;
      let commits = 0;
      let markDropped: () => void = () => {};
      const dropped = new Promise<void>((resolve) => {
        markDropped = resolve;
      });
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.method() !== "POST" || !request.headers()["next-action"]) {
          await route.continue();
          return;
        }
        commits += 1;
        if (commits === 1) {
          firstBody = request.postDataBuffer();
          const url = new URL(request.url());
          const host = url.host;
          url.hostname = "127.0.0.1";
          const response = await Promise.race([
            route.fetch({
              url: url.toString(),
              headers: { ...request.headers(), host },
              postData: firstBody ?? undefined,
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("commit fetch hung")), 20_000)),
          ]);
          await response.text();
          let proofError: unknown;
          try {
            const proved = await prisma.$transaction(async (tx) => {
              const store = await tx.store.findUnique({ where: { slug: "mama-ngozi" } });
              if (!store) throw new Error("mama-ngozi missing");
              await tx.$executeRaw`SET LOCAL ROLE app_user`;
              await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
              const listings = await tx.listing.findMany({ where: { masterProductId: betaId } });
              const skippedRows = await tx.listing.findMany({
                where: { customName: { in: [skipped, keptAside] } },
              });
              const imports = await tx.listingImport.findMany({ where: { csvText: { contains: shared } } });
              const variants = await tx.listingVariant.findMany({ where: { listingId: { in: listings.map((row) => row.id) } } });
              const stock = await tx.stockEvent.findMany({ where: { listingId: { in: listings.map((row) => row.id) } } });
              const audits = await tx.auditLog.findMany({
                where: { action: "catalog.csv_import", entityId: { in: listings.map((row) => row.id) } },
              });
              return { listings, skippedRows, imports, variants, stock, audits };
            });
            expect(response.status()).toBeLessThan(400);
            expect(proved.listings).toHaveLength(1);
            expect(proved.skippedRows).toHaveLength(0);
            expect(proved.imports).toHaveLength(1);
            expect(proved.imports[0]?.status).toBe("committed");
            expect(proved.imports[0]?.commitResult).toBeTruthy();
            expect(proved.variants).toHaveLength(1);
            expect(proved.stock).toHaveLength(1);
            expect(proved.stock[0]?.delta).toBe(6);
            expect(proved.audits.length).toBeGreaterThan(0);
          } catch (error) {
            proofError = error;
          }
          await route.abort("failed");
          markDropped();
          if (proofError) throw proofError;
          return;
        }
        secondBody = request.postDataBuffer();
        await route.continue();
      });

      await page.getByRole("button", { name: "Import 1 listing" }).click({ noWaitAfter: true });
      await dropped;
      await page.unroute("**/*");
      await page.waitForTimeout(1_000);
      const lostText = (await page.locator("[data-sonner-toast]").allInnerTexts()).join("\n");
      expect(lostText).toContain("We couldn't confirm the import. Press Import again. Nothing will be imported twice.");
      const ui = await page.evaluate(() => {
        const text = document.body.innerText;
        const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes("Import 1 listing"));
        return {
          complete: text.includes("Import Complete"),
          ambiguous: text.includes("Ambiguous Matches"),
          buttonDisabled: button instanceof HTMLButtonElement ? button.disabled : true,
          boxes: [...document.querySelectorAll("input[type=checkbox]")].map((el) => (el as HTMLInputElement).checked),
          radios: [...document.querySelectorAll("input[type=radio]")].map((el) => ({
            label: (el.parentElement?.innerText ?? "").trim(),
            checked: (el as HTMLInputElement).checked,
          })),
        };
      });
      if (ui.complete || !ui.ambiguous || ui.buttonDisabled) throw new Error(`preview was not kept: ${JSON.stringify(ui)}`);
      if (ui.boxes.join(",") !== "false,false") throw new Error(`checks changed: ${ui.boxes.join(",")}`);
      if (!ui.radios.find((radio) => radio.label.includes(betaName))?.checked) throw new Error("beta was not kept");
      if (ui.radios.find((radio) => radio.label.includes(alphaName))?.checked) throw new Error("alpha was selected");
      const snapshotPersisted = async () =>
        prisma.$transaction(async (tx) => {
          const store = await tx.store.findUnique({ where: { slug: "mama-ngozi" } });
          if (!store) throw new Error("mama-ngozi missing");
          await tx.$executeRaw`SET LOCAL ROLE app_user`;
          await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
          const listings = await tx.listing.findMany({ where: { masterProductId: betaId } });
          const alphaListings = await tx.listing.findMany({ where: { masterProductId: alphaId } });
          const customs = await tx.listing.findMany({ where: { customName: { in: [skipped, keptAside] } } });
          const listingIds = listings.map((row) => row.id);
          const variants = await tx.listingVariant.findMany({ where: { listingId: { in: listingIds } } });
          const stock = await tx.stockEvent.findMany({ where: { listingId: { in: listingIds } } });
          const audits = await tx.auditLog.findMany({
            where: { action: "catalog.csv_import", entityId: { in: listingIds } },
          });
          const receipt = await tx.listingImport.findFirst({ where: { csvText: { contains: shared } } });
          const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
          return {
            listings: byId(listings).map((row) => ({
              id: row.id,
              masterProductId: row.masterProductId,
              customName: row.customName,
              price: row.price,
              qty: row.qty,
              stockMode: row.stockMode,
              status: row.status,
              active: row.active,
            })),
            alphaListingIds: byId(alphaListings).map((row) => row.id),
            customListingIds: byId(customs).map((row) => row.id),
            variants: byId(variants).map((row) => ({
              id: row.id,
              listingId: row.listingId,
              label: row.label,
              price: row.price,
              weightG: row.weightG,
              weightPlaceholder: row.weightPlaceholder,
            })),
            stock: byId(stock).map((row) => ({
              id: row.id,
              listingId: row.listingId,
              type: row.type,
              delta: row.delta,
            })),
            audits: byId(audits).map((row) => ({
              id: row.id,
              action: row.action,
              entityType: row.entityType,
              entityId: row.entityId,
              before: row.before,
              after: row.after,
            })),
            receipt: receipt
              ? {
                  id: receipt.id,
                  status: receipt.status,
                  commitResult: receipt.commitResult,
                  committedAt: receipt.committedAt?.toISOString() ?? null,
                }
              : null,
          };
        }, { timeout: 8_000, maxWait: 3_000 });
      const beforeRetry = await snapshotPersisted();
      page.on("request", (request) => {
        if (request.method() === "POST" && request.headers()["next-action"]) {
          secondBody = request.postDataBuffer();
        }
      });
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes("Import 1 listing"));
        if (!(button instanceof HTMLButtonElement)) throw new Error("import button missing");
        button.click();
      });
      let imported = "";
      const retryStarted = Date.now();
      while (!imported.includes("Imported 1 listing.") && Date.now() - retryStarted < 20_000) {
        imported = (await page.locator("[data-sonner-toast]").allInnerTexts()).join("\n");
        if (!imported.includes("Imported 1 listing.")) await page.waitForTimeout(200);
      }
      expect(imported).toContain("Imported 1 listing.");
      let complete = false;
      const completeStarted = Date.now();
      while (!complete && Date.now() - completeStarted < 10_000) {
        complete = await page.evaluate(() => document.body.innerText.includes("Import Complete"));
        if (!complete) await page.waitForTimeout(200);
      }
      expect(complete).toBe(true);
      expect(firstBody).not.toBeNull();
      expect(secondBody).not.toBeNull();
      expect(Buffer.compare(firstBody!, secondBody!)).toBe(0);

      const afterRetry = await snapshotPersisted();
      expect(afterRetry).toEqual(beforeRetry);
      expect(afterRetry.listings).toHaveLength(1);
      expect(afterRetry.alphaListingIds).toHaveLength(0);
      expect(afterRetry.customListingIds).toHaveLength(0);
      expect(afterRetry.variants).toHaveLength(1);
      expect(afterRetry.stock).toHaveLength(1);
      expect(afterRetry.stock[0]?.delta).toBe(6);
      expect(afterRetry.audits.length).toBeGreaterThan(0);
      expect(afterRetry.receipt?.status).toBe("committed");
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        const ids = [alphaId, betaId].filter(Boolean);
        if (ids.length > 0) {
          const listings = await tx.listing.findMany({ where: { masterProductId: { in: ids } }, select: { id: true } });
          const listingIds = listings.map((row) => row.id);
          if (listingIds.length > 0) {
            await tx.stockEvent.deleteMany({ where: { listingId: { in: listingIds } } });
            await tx.listingVariant.deleteMany({ where: { listingId: { in: listingIds } } });
            await tx.listing.deleteMany({ where: { id: { in: listingIds } } });
          }
          await tx.productSynonym.deleteMany({ where: { productId: { in: ids } } });
          await tx.masterProduct.deleteMany({ where: { id: { in: ids } } });
        }
        await tx.listingImport.deleteMany({ where: { csvText: { contains: shared } } });
      });
      await prisma.$disconnect();
    }
  });

  test("a raw action body above CSV cap plus 64 KiB is rejected without storing a preview", async ({ page }) => {
    test.setTimeout(60_000);
    const name = `E2E Cap ${Date.now()}`;
    const csvPath = writeTempCsv(`name,price\n${name},1.00\n`);
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    let status = 0;
    let paddedOnce = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (paddedOnce || request.method() !== "POST" || !request.headers()["next-action"]) {
        await route.continue();
        return;
      }
      paddedOnce = true;
      const body = request.postDataBuffer() ?? Buffer.alloc(0);
      const type = request.headers()["content-type"] ?? "";
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
      const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
      if (!boundary) throw new Error("preview request has no multipart boundary");
      const fileMarker = Buffer.from('name="_1_file"');
      const fileAt = body.indexOf(fileMarker);
      if (fileAt < 0) throw new Error("preview request has no file part");
      const headerEnd = body.indexOf("\r\n\r\n", fileAt);
      const nextPart = headerEnd < 0 ? -1 : body.indexOf(`\r\n--${boundary}`, headerEnd + 4);
      if (headerEnd < 0 || nextPart < 0) throw new Error("file part is not a complete multipart field");
      const csvBytes = fs.readFileSync(csvPath);
      const withFile = body.subarray(headerEnd + 4, nextPart).indexOf(name) >= 0
        ? body
        : Buffer.concat([body.subarray(0, headerEnd + 4), csvBytes, body.subarray(headerEnd + 4)]);
      const closing = Buffer.from(`--${boundary}--`);
      const at = withFile.lastIndexOf(closing);
      if (at < 0) throw new Error("preview request has no closing boundary");
      const target = 2_162_688 + 4096;
      const partHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pad"\r\n\r\n`);
      const tail = Buffer.from(`\r\n`);
      const filler = target - withFile.length - partHeader.length - tail.length;
      if (filler < 1) throw new Error("preview body is already over the cap");
      const padded = Buffer.concat([
        withFile.subarray(0, at),
        partHeader,
        Buffer.alloc(filler, 0x78),
        tail,
        withFile.subarray(at),
      ]);
      expect(padded.length).toBe(target);
      expect(padded.length).toBeGreaterThan(2_162_688);
      expect(padded.length).toBeLessThan(3 * 1024 * 1024);
      const form = await new Response(padded, { headers: { "content-type": type } }).formData();
      expect(form.has("pad")).toBe(true);
      expect(typeof form.get("pad")).toBe("string");
      const root = form.get("0");
      if (typeof root !== "string") throw new Error("action root was not text");
      JSON.parse(root);
      const uploaded = form.get("_1_file");
      if (!(uploaded instanceof File)) throw new Error("CSV file part was missing");
      expect(await uploaded.text()).toContain(name);
      expect(uploaded.size).toBe(csvBytes.length);
      const url = new URL(request.url());
      const host = url.host;
      url.hostname = "127.0.0.1";
      const headers = { ...request.headers(), host, "content-length": String(padded.length) };
      const response = await route.fetch({ url: url.toString(), postData: padded, headers });
      status = response.status();
      const text = await response.text();
      // Next's fetch-action handler logs ApiError 413 and then forces HTTP 500
      // (action-handler.js: the 413 status is still a TODO on this path).
      expect(status).toBe(500);
      expect(text).toContain("digest");
      await route.fulfill({ status, headers: response.headers(), body: text });
    });
    try {
      await page.goto(IMPORT_URL);
      await page.locator("input[type='file']").setInputFiles(csvPath);
      await page.click("text=Upload & Preview");
      await expect.poll(() => status, { timeout: 20_000 }).toBe(500);
      await expect(page.locator("[data-sonner-toast]")).toContainText(
        "Upload failed. The file may be too large or the server is unavailable.",
        { timeout: 20_000 },
      );
      await expect(page.getByText("New listings", { exact: true })).toHaveCount(0);
      const stored = await prisma.$transaction(async (tx) => {
        const store = await tx.store.findUnique({ where: { slug: "mama-ngozi" } });
        if (!store) throw new Error("mama-ngozi missing");
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
        return tx.listingImport.count({ where: { csvText: { contains: name } } });
      });
      expect(stored).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
