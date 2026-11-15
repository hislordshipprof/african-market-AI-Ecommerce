import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { E2E_STORE_SLUG } from "./cleanup-listings";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const RUN = `e2edp${Date.now().toString(36)}`;
const PROOF_DIR = process.env.PROOF_DIR;

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function withDb<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
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

// Names carry no run prefix (it would make every pair alike); the run's own category keeps them apart.
const KEEP = "Ewedu leaves, dried";
const MERGE = "Dried ewedu leaves";
const UGU = "Ugu leaves";
const UGWU = "Ugwu leaves";
const ids: Record<string, string> = {};

test.describe("Master catalog duplicates", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await withDb(async (tx) => {
      ids.category = (await tx.category.create({ data: { name: `${RUN} Vegetables`, slug: `${RUN}-veg`, sortOrder: 990 } })).id;
      const make = async (key: string, name: string, synonyms: string[]) => {
        ids[key] = (await tx.masterProduct.create({
          data: { name, categoryId: ids.category, status: "active", synonyms: { create: synonyms.map((term) => ({ term })) } },
        })).id;
      };
      await make("keep", KEEP, ["ewedu", "jute leaves"]);
      await make("merge", MERGE, ["ewedu", "molokhia"]);
      await make("ugu", UGU, ["fluted pumpkin"]);
      await make("ugwu", UGWU, ["fluted pumpkin"]);
      const store = await tx.store.findUniqueOrThrow({ where: { slug: E2E_STORE_SLUG } });
      ids.store = store.id;
      // The e2e store lists both products; after the merge it keeps both listings.
      for (const key of ["keep", "merge"]) {
        ids[`listing-${key}`] = (await tx.listing.create({
          data: { storeId: store.id, masterProductId: ids[key], price: 399, stockMode: "untracked", active: false, variants: { create: [{ label: "100 g", price: 399, weightG: 100 }] } },
        })).id;
      }
    });
  });

  test.afterAll(async () => {
    await withDb(async (tx) => {
      const products = [ids.keep, ids.merge, ids.ugu, ids.ugwu];
      await tx.listingVariant.deleteMany({ where: { listingId: { in: [ids["listing-keep"], ids["listing-merge"]] } } });
      await tx.listing.deleteMany({ where: { id: { in: [ids["listing-keep"], ids["listing-merge"]] } } });
      const pairs = await tx.catalogDuplicatePair.findMany({ where: { OR: [{ productAId: { in: products } }, { productBId: { in: products } }] }, select: { id: true } });
      await tx.auditLog.deleteMany({ where: { entityId: { in: [...products, ...pairs.map((pair) => pair.id)] } } });
      await tx.catalogDuplicatePair.deleteMany({ where: { OR: [{ productAId: { in: products } }, { productBId: { in: products } }] } });
      await tx.masterProduct.updateMany({ where: { id: { in: products } }, data: { status: "archived", mergedIntoId: null } });
      await tx.productSynonym.deleteMany({ where: { productId: { in: products } } });
      await tx.masterProduct.deleteMany({ where: { id: { in: products } } });
      await tx.category.deleteMany({ where: { id: ids.category } });
    });
  });

  test("a guest is sent to sign-in", async ({ page }) => {
    await page.goto("/admin/catalog/duplicates");
    await expect(page).toHaveURL(/\/admin\/sign-in/);
  });

  test("finds the pairs, merges one keeping every listing, and remembers Not a duplicate", async ({ page }) => {
    test.setTimeout(120_000);
    await adminSignIn(page);
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Duplicates" }).click();
    await expect(page.locator("h1")).toHaveText("Duplicates");
    await expect(page.getByRole("navigation", { name: "Admin" }).locator("[aria-current='page']")).toHaveText("Duplicates");

    await page.getByRole("button", { name: "Find duplicates" }).click();
    await expect(page.getByRole("status").filter({ hasText: /possible duplicates? found/ })).toBeVisible({ timeout: 90_000 });

    const pair = page.getByRole("article", { name: `${KEEP} and ${MERGE}` }).or(page.getByRole("article", { name: `${MERGE} and ${KEEP}` }));
    await expect(pair).toBeVisible();
    // The e2e server has no model key, so the pair shows unjudged.
    await expect(pair.getByText("Not judged yet")).toBeVisible();
    await expect(pair.getByText("molokhia")).toBeVisible();
    await expect(pair.getByText(/Mama Ngozi.*: 1/).first()).toBeVisible();

    if (PROOF_DIR) {
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await pair.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${PROOF_DIR}/duplicates-${width}-${scheme}.png`, fullPage: false });
        }
      }
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    const keep = pair.getByRole("radio", { name: "Keep this one" });
    await expect(pair.getByRole("button", { name: "Merge" })).toBeDisabled();
    await pair.locator("label").filter({ has: page.locator(`input[value='${ids.keep}']`) }).click();
    await expect(keep.and(page.locator(`[value='${ids.keep}']`))).toBeChecked();
    await pair.getByRole("button", { name: "Merge" }).click();
    await expect(pair.getByText(`Merge ${MERGE} into ${KEEP}?`)).toBeVisible();
    if (PROOF_DIR) await page.screenshot({ path: `${PROOF_DIR}/duplicates-1280-light-confirm.png` });
    await pair.getByRole("button", { name: "Confirm merge" }).click();
    await expect(pair).toBeHidden({ timeout: 15_000 });

    const merged = await withDb(async (tx) => ({
      loser: await tx.masterProduct.findUniqueOrThrow({ where: { id: ids.merge } }),
      listings: await tx.listing.findMany({ where: { id: { in: [ids["listing-keep"], ids["listing-merge"]] } }, select: { id: true, masterProductId: true, storeId: true } }),
    }));
    expect(merged.loser).toMatchObject({ status: "merged", mergedIntoId: ids.keep });
    expect(merged.listings).toHaveLength(2);
    expect(merged.listings.every((listing) => listing.masterProductId === ids.keep && listing.storeId === ids.store)).toBe(true);

    const ugu = page.getByRole("article", { name: `${UGU} and ${UGWU}` }).or(page.getByRole("article", { name: `${UGWU} and ${UGU}` }));
    await ugu.getByRole("button", { name: "Not a duplicate" }).click();
    await expect(ugu).toBeHidden({ timeout: 15_000 });
    await page.getByRole("button", { name: "Find duplicates" }).click();
    await expect(page.getByRole("status").filter({ hasText: /possible duplicates? found/ })).toBeVisible({ timeout: 90_000 });
    await expect(ugu).toBeHidden();

    // The merged product's editor says where it went and has no form.
    await page.goto(`/admin/catalog/products/${ids.merge}`);
    await expect(page.getByText("Merged into")).toBeVisible();
    await expect(page.getByRole("link", { name: KEEP })).toBeVisible();
    await expect(page.getByRole("button", { name: /Save/ })).toHaveCount(0);
  });
});
