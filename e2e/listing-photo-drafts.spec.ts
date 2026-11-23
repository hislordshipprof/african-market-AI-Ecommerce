import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { deleteE2eListings, E2E_STORE_SLUG } from "./cleanup-listings";
import { storeOwnerSignIn } from "./store-owner-auth";
import { generateTOTP } from "./totp";

const PAGE_URL = `/store-admin/listings/from-photos?store=${E2E_STORE_SLUG}`;
const NAME = `E2E Shelf Draft ${Date.now()}`;
const SUGGESTED = `E2E Shelf Suggest ${Date.now()}`;
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

async function asPlatform<T>(run: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
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
  await page.getByLabel("Email").fill("admin@platform.test");
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").waitFor({ state: "visible" });
  await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
  await page.click("button[type='submit']");
  await page.waitForURL("**/admin");
}

/** Drafts are seeded straight into the table: the e2e server has no model key, so no photo is read here. */
async function withStore<T>(run: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0], storeId: string, ownerId: string) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: E2E_STORE_SLUG } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: "owner@mama-ngozi.test" } });
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      return run(tx, store.id, owner.id);
    });
  } finally {
    await prisma.$disconnect();
  }
}

test.describe("Listings from shelf photos", () => {
  // Both publish from the same page: keep them from reading each other's rows mid-run.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await withStore((tx, storeId, ownerId) => tx.listingDraft.create({
      data: {
        storeId,
        createdById: ownerId,
        photoKey: `listing-photos/${storeId}/e2e${Date.now()}.jpg`,
        extractedName: NAME,
        extractedSize: "500g",
        priceReadCents: 349,
        match: "none",
      },
    }));
    await withStore((tx, storeId, ownerId) => tx.listingDraft.create({
      data: { storeId, createdById: ownerId, photoKey: `listing-photos/${storeId}/e2es${Date.now()}.jpg`, extractedName: SUGGESTED, extractedSize: "250g", match: "none" },
    }));
  });

  test.afterAll(async () => {
    // The suggested listing was re-pointed to a new master product, so it is removed by id, not by name.
    await asPlatform(async (tx) => {
      const proposals = await tx.productProposal.findMany({ where: { name: SUGGESTED } });
      const listingIds = proposals.map((row) => row.listingId);
      const productIds = proposals.flatMap((row) => (row.masterProductId ? [row.masterProductId] : []));
      await tx.productProposal.deleteMany({ where: { id: { in: proposals.map((row) => row.id) } } });
      await tx.listingDraft.deleteMany({ where: { extractedName: { in: [NAME, SUGGESTED] } } });
      await tx.stockEvent.deleteMany({ where: { listingId: { in: listingIds } } });
      await tx.listing.deleteMany({ where: { id: { in: listingIds } } });
      await tx.productSynonym.deleteMany({ where: { productId: { in: productIds } } });
      await tx.masterProduct.deleteMany({ where: { id: { in: productIds } } });
    });
    await deleteE2eListings({ names: [`${NAME} 500g`] });
  });

  test("a price read from the photo publishes only after the owner checks it", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(PAGE_URL);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add listings from shelf photos");
    const row = page.getByRole("region", { name: /To review/ }).getByRole("listitem").filter({ hasText: NAME });
    await expect(row.getByText("Read from photo, check it")).toBeVisible();
    await expect(row.getByLabel("Price", { exact: true })).toHaveValue("3.49");

    await row.getByLabel(`Select ${NAME}`).check();
    await page.getByRole("button", { name: /^Publish/ }).click();
    await expect(page.getByText(`${NAME}: check the price first.`)).toBeVisible();
    await expect(row).toBeVisible();

    await row.getByLabel("Price checked").check();
    await page.getByRole("button", { name: /^Publish/ }).click();
    await expect(page.getByText("Published 1 listing.")).toBeVisible();
    await expect(page.getByRole("region", { name: /To review/ }).getByRole("listitem").filter({ hasText: NAME })).toHaveCount(0);

    const listing = await withStore((tx) => tx.listing.findFirst({ where: { customName: `${NAME} 500g` }, select: { price: true } }));
    expect(listing).toEqual({ price: 349 });
  });

  test("an unmatched item sells at once, is suggested for the catalog and an admin adds it", async ({ page, browser }) => {
    await storeOwnerSignIn(page);
    await page.goto(PAGE_URL);
    const row = page.getByRole("region", { name: /To review/ }).getByRole("listitem").filter({ hasText: SUGGESTED });
    await row.getByLabel(`Select ${SUGGESTED}`).check();
    await row.getByLabel("Price", { exact: true }).fill("2.75");
    await row.getByLabel("Also suggest it for the shared catalog").check();
    await expect(row.getByLabel("Product name")).toHaveValue(SUGGESTED);
    await expect(row.getByLabel("Size or pack")).toHaveValue("250g");
    await row.getByLabel(/Local name/).fill("Iru pete");
    await page.getByRole("button", { name: /^Publish/ }).click();
    await expect(page.getByText("Suggested 1 item for the shared catalog.")).toBeVisible();
    const suggested = page.getByRole("region", { name: /Suggested for the catalog/ }).getByRole("listitem").filter({ hasText: SUGGESTED });
    await expect(suggested).toContainText("Waiting for the platform team");

    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await adminSignIn(admin);
    await admin.goto("/admin/catalog/review?status=suggestions");
    const card = admin.getByRole("article", { name: new RegExp(SUGGESTED) });
    await expect(card).toContainText("sells it as");
    await expect(card).toContainText("$2.75");
    await card.getByRole("button", { name: "Approve and add to catalog" }).click();
    await expect(card).toHaveCount(0);
    await adminContext.close();

    await page.reload();
    await expect(page.getByRole("region", { name: /Suggested for the catalog/ }).getByRole("listitem").filter({ hasText: SUGGESTED }))
      .toContainText(`In the catalog as ${SUGGESTED}`);
    const proposal = await asPlatform((tx) => tx.productProposal.findFirstOrThrow({ where: { name: SUGGESTED }, include: { listing: true } }));
    expect([proposal.status, proposal.listing.masterProductId, proposal.listing.customName, proposal.listing.price]).toEqual(["approved", proposal.masterProductId, null, 275]);
  });

  test("photos that fail to send stay listed with their error, and Retry sends only that photo", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(PAGE_URL);
    // A 1x1 PNG; every upload is dropped, so nothing reaches the photo reader.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    let sent = 0;
    await page.route("**/store-admin/listings/from-photos**", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      sent += 1;
      await route.abort("failed");
    });
    await page.getByLabel("Take or choose shelf photos").setInputFiles([
      { name: "shelf-one.png", mimeType: "image/png", buffer: png },
      { name: "shelf-two.png", mimeType: "image/png", buffer: png },
    ]);
    await page.getByRole("button", { name: "Read photos" }).click();

    const photos = page.getByRole("list", { name: "Photos to read" });
    await expect(photos.getByRole("listitem")).toHaveCount(2);
    await expect(photos.getByText("The photo could not be sent. Check your connection and retry.")).toHaveCount(2);
    expect(sent).toBe(2);

    await page.getByRole("button", { name: "Retry shelf-two.png" }).click();
    await expect.poll(() => sent).toBe(3);
    await expect(page.getByRole("button", { name: "Retry all" })).toBeEnabled();
    await expect(photos.getByText("shelf-one.png")).toBeVisible();
    await expect(photos.getByText("shelf-two.png")).toBeVisible();
    expect(sent).toBe(3);
  });

  test("the products page links to it", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/listings?store=${E2E_STORE_SLUG}`);
    await expect(page.getByRole("link", { name: "From photos" })).toHaveAttribute("href", PAGE_URL);
  });
});
