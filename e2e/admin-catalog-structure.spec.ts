import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const RUN = `e2ecs${Date.now().toString(36)}`;

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

test.describe("Master catalog synonyms and categories", () => {
  // One shared admin: keep the TOTP sign-ins from overlapping.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await asAdmin(async (tx) => {
      ids.whole = (await tx.masterProduct.create({ data: { name: `${RUN} Egusi whole`, status: "active" } })).id;
      ids.ground = (await tx.masterProduct.create({ data: { name: `${RUN} Egusi ground`, status: "active" } })).id;
      await tx.productSynonym.create({ data: { productId: ids.whole, term: `${RUN} agushi`, language: "tw", region: "Ghana" } });
    });
  });

  test.afterAll(async () => {
    await asAdmin(async (tx) => {
      const categories = await tx.category.findMany({ where: { slug: { startsWith: RUN } }, select: { id: true, parentId: true } });
      const entityIds = [ids.whole, ids.ground, ...categories.map((c) => c.id)];
      await tx.auditLog.deleteMany({ where: { entityId: { in: entityIds } } });
      await tx.masterProduct.deleteMany({ where: { id: { in: [ids.whole, ids.ground] } } });
      await tx.category.deleteMany({ where: { id: { in: categories.filter((c) => c.parentId).map((c) => c.id) } } });
      await tx.category.deleteMany({ where: { id: { in: categories.map((c) => c.id) } } });
    });
  });

  test("a guest is sent to sign-in", async ({ page }) => {
    await page.goto("/admin/catalog/categories");
    await expect(page).toHaveURL(/\/admin\/sign-in/);
  });

  test("synonyms: add with a language, the shared-term warning, the duplicate refusal, edit and remove", async ({ page }) => {
    await adminSignIn(page);
    await page.goto(`/admin/catalog/products/${ids.ground}`);
    const add = page.getByRole("form", { name: "Add a term" });
    const list = page.getByRole("list", { name: "Synonyms" });

    await add.getByLabel("Term").fill(`${RUN} agushi`);
    await add.getByLabel("Language").selectOption("tw");
    await add.getByLabel("Region").fill("Ghana");
    await add.getByRole("button", { name: "Add term" }).click();
    await expect(add.getByRole("status")).toContainText(`also names ${RUN} Egusi whole`);
    await expect(list.getByRole("listitem").filter({ hasText: `${RUN} agushi` })).toContainText(`Also names ${RUN} Egusi whole`);
    await expect(list.getByRole("listitem").filter({ hasText: `${RUN} agushi` })).toContainText("Twi (tw), Ghana");

    await add.getByLabel("Term").fill(`${RUN} AGUSHI`);
    await add.getByRole("button", { name: "Add term" }).click();
    await expect(add.getByText("This product already has this term")).toBeVisible();
    await expect(add.getByLabel("Term")).toBeFocused();

    await add.getByLabel("Term").fill(`${RUN} egwusi`);
    await add.getByLabel("Language").selectOption("other");
    await add.getByLabel("ISO 639 code").fill("Igbo language");
    await add.getByRole("button", { name: "Add term" }).click();
    await expect(add.getByText(/ISO 639 language code/)).toBeVisible();
    await add.getByLabel("ISO 639 code").fill("ig");
    await add.getByRole("button", { name: "Add term" }).click();
    const egwusi = list.getByRole("listitem").filter({ hasText: `${RUN} egwusi` });
    await expect(egwusi).toContainText("Igbo (ig)");

    await egwusi.getByRole("button", { name: `Edit ${RUN} egwusi` }).click();
    const edit = page.getByRole("form", { name: `Edit ${RUN} egwusi` });
    await edit.getByLabel("Region").fill("Nigeria");
    await edit.getByRole("button", { name: "Save term" }).click();
    await expect(egwusi).toContainText("Igbo (ig), Nigeria");

    page.once("dialog", (dialog) => dialog.accept());
    await egwusi.getByRole("button", { name: `Remove ${RUN} egwusi` }).click();
    await expect(list.getByRole("listitem").filter({ hasText: `${RUN} egwusi` })).toHaveCount(0);

    const audits = await asAdmin((tx) => tx.auditLog.findMany({ where: { entityId: ids.ground }, orderBy: { createdAt: "asc" }, select: { action: true } }));
    expect(audits.map((row) => row.action)).toEqual(["catalog.synonym_add", "catalog.synonym_add", "catalog.synonym_edit", "catalog.synonym_remove"]);
  });

  test("categories: add, nest one level, rename with a local name, reorder and delete an empty one", async ({ page }) => {
    await adminSignIn(page);
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Categories" }).click();
    await expect(page.locator("h1")).toHaveText("Categories");
    await expect(page.getByRole("navigation", { name: "Admin" }).locator("[aria-current='page']")).toHaveText("Categories");

    const add = page.getByRole("region", { name: "Add a category" });
    await add.getByLabel("Name", { exact: true }).fill(`${RUN} Soups`);
    await add.getByRole("button", { name: "Add category" }).click();
    await expect(add.getByRole("status")).toHaveText("Category added");
    for (const name of ["Egusi soup", "Okra soup"]) {
      await add.getByLabel("Name", { exact: true }).fill(`${RUN} ${name}`);
      await add.getByLabel("Parent").selectOption({ label: `${RUN} Soups` });
      await add.getByRole("button", { name: "Add category" }).click();
      await expect(page.getByRole("list", { name: `Subcategories of ${RUN} Soups` }).getByRole("listitem")).toContainText([`${RUN} ${name}`]);
    }

    const children = page.getByRole("list", { name: `Subcategories of ${RUN} Soups` }).getByRole("listitem");
    await expect(children).toHaveText([new RegExp(`${RUN} Egusi soup`), new RegExp(`${RUN} Okra soup`)]);
    await page.getByRole("button", { name: `Move ${RUN} Okra soup up` }).click();
    await expect(children).toHaveText([new RegExp(`${RUN} Okra soup`), new RegExp(`${RUN} Egusi soup`)]);

    await page.getByRole("link", { name: new RegExp(`^${RUN} Okra soup`) }).click();
    await expect(page.locator("h1")).toHaveText(`${RUN} Okra soup`);
    await page.getByLabel("Name", { exact: true }).fill(`${RUN} Okra and ogbono`);
    await page.getByLabel("Local name").fill("OBE ILA");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await expect(page.locator("h1")).toHaveText(`${RUN} Okra and ogbono`);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete category" }).click();
    await page.waitForURL("**/admin/catalog/categories");
    await expect(page.getByRole("list", { name: `Subcategories of ${RUN} Soups` }).getByRole("listitem")).toHaveText([new RegExp(`${RUN} Egusi soup`)]);

    // A parent with a subcategory offers no delete.
    await page.getByRole("link", { name: new RegExp(`^${RUN} Soups`) }).click();
    await expect(page.getByText("Move or delete its subcategories first.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete category" })).toHaveCount(0);

    const okra = await asAdmin((tx) => tx.auditLog.findMany({ where: { action: { startsWith: "catalog.category_" }, actorEmail: ADMIN_EMAIL, before: { path: ["name"], equals: `${RUN} Okra and ogbono` } } }));
    expect(okra.map((row) => row.action)).toEqual(["catalog.category_delete"]);
  });
});
