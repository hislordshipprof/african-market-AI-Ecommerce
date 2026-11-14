import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const RUN = `e2emc${Date.now().toString(36)}`;

async function asAdmin<T>(run: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return run(tx);
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function adminSignIn(page: Page) {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").waitFor({ state: "visible" });
  await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
  await page.click("button[type='submit']");
  await page.waitForURL("**/admin");
}

const ids: Record<string, string> = {};

test.describe("Master catalog products", () => {
  // One shared admin: keep the TOTP sign-ins from overlapping.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await asAdmin(async (tx) => {
      const category = await tx.category.findFirstOrThrow({ orderBy: { sortOrder: "asc" } });
      ids.category = category.id;
      ids.yam = (await tx.masterProduct.create({ data: { name: `${RUN} Pounded yam`, categoryId: category.id, status: "active", unit: "bag" } })).id;
      ids.kola = (await tx.masterProduct.create({ data: { name: `${RUN} Kola nut`, status: "archived" } })).id;
    });
  });

  test.afterAll(async () => {
    await asAdmin(async (tx) => {
      await tx.auditLog.deleteMany({ where: { entityId: { in: [ids.yam, ids.kola] } } });
      await tx.masterProduct.deleteMany({ where: { id: { in: [ids.yam, ids.kola] } } });
    });
  });

  test("a guest is sent to sign-in", async ({ page }) => {
    await page.goto(`/admin/catalog/products/${ids.yam}`);
    await expect(page).toHaveURL(/\/admin\/sign-in/);
  });

  test("search and filters find products, and the menu marks Products", async ({ page }) => {
    await adminSignIn(page);
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Products" }).click();
    await expect(page.locator("h1")).toHaveText("Products");
    await expect(page.getByRole("navigation", { name: "Admin" }).locator("[aria-current='page']")).toHaveText("Products");

    await page.getByLabel("Search").fill(RUN);
    await page.getByRole("button", { name: "Show products" }).click();
    const results = page.getByRole("main").getByRole("listitem");
    await expect(results.filter({ hasText: RUN })).toHaveCount(2);

    await page.getByLabel("Status").selectOption("archived");
    await page.getByLabel("Photo").selectOption("missing");
    await page.getByRole("button", { name: "Show products" }).click();
    await expect(page).toHaveURL(/status=archived/);
    await expect(results.filter({ hasText: RUN })).toHaveCount(1);
    await expect(results.filter({ hasText: `${RUN} Kola nut` })).toContainText("Archived");
  });

  test("the editor saves the fields, keeps a refused value, and archives", async ({ page }) => {
    await adminSignIn(page);
    await page.goto(`/admin/catalog/products?q=${RUN}`);
    await page.getByRole("link", { name: new RegExp(`${RUN} Pounded yam`) }).click();
    await expect(page.locator("h1")).toHaveText(`${RUN} Pounded yam`);

    await page.getByLabel("Weight (grams)").fill("12.5");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Enter the weight in whole grams")).toBeVisible();
    await expect(page.getByLabel("Weight (grams)")).toHaveValue("12.5");
    await expect(page.getByLabel("Weight (grams)")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Weight (grams)")).toBeFocused();

    await page.getByLabel("Name").fill(`${RUN} Pounded yam flour`);
    await page.getByLabel("Weight (grams)").fill("1814");
    await page.getByLabel("Storage").selectOption("ambient");
    await page.getByLabel("Perishable").check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await expect(page.locator("h1")).toHaveText(`${RUN} Pounded yam flour`);

    await page.reload();
    await expect(page.getByLabel("Weight (grams)")).toHaveValue("1814");
    await expect(page.getByLabel("Storage")).toHaveValue("ambient");
    await expect(page.getByLabel("Perishable")).toBeChecked();

    await page.getByLabel("Status").selectOption("archived");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await expect(page.getByRole("main").getByText(/^Archived\./)).toBeVisible();

    const audits = await asAdmin((tx) => tx.auditLog.findMany({ where: { entityId: ids.yam, action: "catalog.product_edit" }, orderBy: { createdAt: "asc" } }));
    expect(audits.map((row) => row.after)).toEqual([
      { name: `${RUN} Pounded yam flour`, weightG: 1814, perishable: true, storage: "ambient" },
      { status: "archived" },
    ]);
  });

  test("an SVG photo is refused by its bytes", async ({ page }) => {
    await adminSignIn(page);
    await page.goto(`/admin/catalog/products/${ids.kola}`);
    await page.getByLabel("New photo").setInputFiles({
      name: "kola.png",
      mimeType: "image/png",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'),
    });
    await page.getByRole("button", { name: "Upload photo" }).click();
    await expect(page.getByText("SVG images are not accepted. Upload a JPEG, PNG or WebP photo.")).toBeVisible();
    const product = await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: ids.kola } }));
    expect(product.imageUrl).toBeNull();
  });
});
