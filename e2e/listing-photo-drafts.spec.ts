import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { deleteE2eListings, E2E_STORE_SLUG } from "./cleanup-listings";
import { storeOwnerSignIn } from "./store-owner-auth";

const PAGE_URL = `/store-admin/listings/from-photos?store=${E2E_STORE_SLUG}`;
const NAME = `E2E Shelf Draft ${Date.now()}`;

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
  });

  test.afterAll(async () => {
    await withStore((tx) => tx.listingDraft.deleteMany({ where: { extractedName: NAME } }));
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

  test("the products page links to it", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/listings?store=${E2E_STORE_SLUG}`);
    await expect(page.getByRole("link", { name: "From photos" })).toHaveAttribute("href", PAGE_URL);
  });
});
