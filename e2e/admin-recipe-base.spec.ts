import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const RUN = `e2erb${Date.now().toString(36)}`;

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

test.describe("Recipe base admin", () => {
  // One shared admin: keep the TOTP sign-ins from overlapping.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await asAdmin(async (tx) => {
      ids.product = (await tx.masterProduct.create({ data: { name: `${RUN} Black-eyed beans`, status: "active" } })).id;
      const make = async (label: string, origin: string, sourceUrl: string | null, aliases: string[] = []) => {
        ids[label] = (await tx.recipe.create({
          data: {
            key: `${RUN} ${label}`,
            name: `${RUN} ${label}`,
            aliases,
            origin,
            sourceUrl,
            ingredients: { create: [{ position: 0, name: "beans" }] },
          },
        })).id;
      };
      await make("ndole", "curated", null, [`${RUN} bitterleaf stew`]);
      await make("red red", "lookup", "https://recipes.example/red-red");
      await make("kontomire", "lookup", "https://recipes.example/kontomire");
    });
  });

  test.afterAll(async () => {
    await asAdmin(async (tx) => {
      await tx.auditLog.deleteMany({ where: { entityId: { in: Object.values(ids) } } });
      await tx.recipe.deleteMany({ where: { id: { in: Object.values(ids) } } });
      await tx.masterProduct.deleteMany({ where: { id: ids.product } });
    });
  });

  test("a guest is sent to sign-in", async ({ page }) => {
    await page.goto(`/admin/catalog/recipes/${ids["red red"]}`);
    await expect(page).toHaveURL(/\/admin\/sign-in/);
  });

  test("the list filters curated and looked-up dishes and shows each source link", async ({ page }) => {
    await adminSignIn(page);
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Recipes" }).click();
    await expect(page.locator("h1")).toHaveText("Recipes");
    await expect(page.getByRole("navigation", { name: "Admin" }).locator("[aria-current='page']")).toHaveText("Recipes");

    await page.getByLabel("Dish name").fill(`${RUN} Red-Red`);
    await page.getByRole("button", { name: "Show dishes" }).click();
    const rows = page.getByRole("main").getByRole("listitem");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Looked up");
    await expect(rows.first().getByRole("link", { name: /recipes\.example/ })).toHaveAttribute("href", "https://recipes.example/red-red");

    await page.goto(`/admin/catalog/recipes?q=${encodeURIComponent(`${RUN} bitterleaf stew`)}&origin=lookup`);
    await expect(page.getByTestId("recipe-count")).toContainText("No dish answers");
    await page.getByLabel("Source").selectOption("curated");
    await page.getByRole("button", { name: "Show dishes" }).click();
    await expect(rows.filter({ hasText: `${RUN} ndole` })).toContainText("Curated");
  });

  test("edits a dish, refuses a name another dish answers to, then marks it curated", async ({ page }) => {
    await adminSignIn(page);
    await page.goto(`/admin/catalog/recipes/${ids["red red"]}`);
    await expect(page.getByRole("link", { name: /recipes\.example\/red-red/ })).toBeVisible();

    await page.getByLabel("Other names").fill(`${RUN} bitterleaf stew`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(`already answers to ${RUN} ndole`)).toBeVisible();
    await expect(page.getByLabel("Other names")).toBeFocused();

    await page.getByLabel("Name", { exact: true }).fill(`${RUN} Red red stew`);
    await page.getByLabel("Other names").fill(`${RUN} gob3`);
    await page.getByLabel("Servings").fill("4");
    await page.getByLabel("Master product").fill(ids.product);
    await expect(page.getByLabel("Master product")).toHaveAccessibleDescription(`${RUN} Black-eyed beans`);
    await page.getByLabel("Quantity").fill("2");
    await page.getByLabel("Unit").fill("cup");
    await page.getByRole("button", { name: "Add ingredient" }).click();
    await page.getByLabel("Ingredient").nth(1).fill("ripe plantain");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");

    const saved = await asAdmin((tx) => tx.recipe.findUniqueOrThrow({ where: { id: ids["red red"] }, include: { ingredients: { orderBy: { position: "asc" } } } }));
    expect(saved).toMatchObject({ key: `${RUN} red red stew`, aliases: [`${RUN} gob3`], servings: 4 });
    expect(saved.ingredients.map((row) => [row.name, row.masterProductId, row.qty?.toString() ?? null, row.unit])).toEqual([
      ["beans", ids.product, "2", "cup"],
      ["ripe plantain", null, null, null],
    ]);

    await page.getByRole("button", { name: "Mark curated" }).click();
    await expect(page.getByRole("heading", { name: "Review" })).toHaveCount(0);
    await expect(page.locator("h1 + span")).toHaveText("Curated");
  });

  test("deletes a looked-up dish with an audit row", async ({ page }) => {
    await adminSignIn(page);
    await page.goto(`/admin/catalog/recipes/${ids.kontomire}`);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete dish" }).click();
    await page.waitForURL("**/admin/catalog/recipes");
    expect(await asAdmin((tx) => tx.recipe.findUnique({ where: { id: ids.kontomire } }))).toBeNull();
    expect(await asAdmin((tx) => tx.auditLog.count({ where: { entityId: ids.kontomire, action: "catalog.recipe_delete" } }))).toBe(1);
  });
});
