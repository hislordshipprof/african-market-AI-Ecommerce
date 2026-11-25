import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";

/** #808: the product page and basket tell the truth about catering terms, allergens and stock left. */

const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
const slug = `truth-${Date.now().toString(36)}`;
let storeId = "";
const ids: Record<"chinChin" | "oxtail" | "puffPuff", string> = { chinChin: "", oxtail: "", puffPuff: "" };

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
const scoped = <T>(run: (tx: Tx) => Promise<T>) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return run(tx);
  });

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Truth Market",
      themePreset: "palm-and-shea",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      timezone: "America/Chicago",
      pickupEnabled: true,
      minimumOrderCents: 0,
      addressLine1: "8400 Park Place Blvd",
      city: "Houston",
      state: "TX",
      zip: "77017",
      lat: 29.693857800118,
      lng: -95.266257879374,
    },
  });
  storeId = store.id;
  await scoped(async (tx) => {
    const listing = (data: Omit<Parameters<Tx["listing"]["create"]>[0]["data"], "storeId">, label: string, weightG: number) =>
      tx.listing
        .create({ data: { storeId, frozen: false, perishable: false, ...data } as Parameters<Tx["listing"]["create"]>[0]["data"] })
        .then(async (row) => {
          await tx.listingVariant.create({ data: { listingId: row.id, label, price: row.price, weightG } });
          return row.id;
        });
    ids.chinChin = await listing(
      { customName: `Chin Chin ${slug}`, price: 599, stockMode: "unlimited", prepared: "cold", cateringLeadHours: 72, cateringMinQty: 4 },
      "8 oz bag",
      227,
    );
    await tx.listingAttributes.create({
      data: { listingId: ids.chinChin, storeId, allergens: ["wheat", "milk"], allergensStatus: "known", dietaryClaims: ["vegetarian"], dietaryStatus: "known" },
    });
    ids.oxtail = await listing({ customName: `Oxtail ${slug}`, price: 1899, stockMode: "counted", qty: 4 }, "1 lb", 454);
    ids.puffPuff = await listing({ customName: `Puff puff ${slug}`, price: 500, stockMode: "status", status: "low" }, "Bag", 300);
  });
});

test.afterAll(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await tx.cartLine.deleteMany({ where: { storeId } });
    await tx.cart.deleteMany({ where: { storeId } });
    await tx.customer.deleteMany({ where: { storeId } });
    await tx.listingVariant.deleteMany({ where: { listing: { storeId } } });
    await tx.listing.deleteMany({ where: { storeId } });
    await tx.auditLog.deleteMany({ where: { storeId } });
  });
  await prisma.store.delete({ where: { id: storeId } });
  await prisma.$disconnect();
});

async function openListing(page: import("@playwright/test").Page, id: string) {
  await expect(async () => {
    await page.goto(`/listings/${id}?store=${slug}`);
    await expect(page.getByTestId("product-detail")).toBeVisible();
  }).toPass({ timeout: 20_000 });
}

test("a catering item shows its lead time, minimum and allergens, and the first add says the minimum went in (AC1, AC2)", async ({ page }) => {
  await openListing(page, ids.chinChin);
  const detail = page.getByTestId("product-detail");
  await expect(detail.getByTestId("catering-terms")).toHaveText("Order 3 days ahead · minimum 4");
  await expect(detail.getByTestId("allergens")).toHaveText("Contains milk, wheat");
  await expect(detail.getByTestId("dietary-claims")).toHaveText("Vegetarian");
  await expect(detail.locator(".sf-add-bar")).toContainText("Adds 4, the minimum");

  await detail.getByRole("button", { name: `Add Chin Chin ${slug} to basket` }).click();
  await expect(detail.getByTestId("stepper-qty")).toHaveText("4");
  await expect(page.getByText(`Chin Chin ${slug}: 4 added, the catering minimum.`)).toBeVisible();
  await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("4");

  // Minus at the minimum takes the line out, as the server would refuse 3.
  await detail.getByTestId("stepper-minus").click();
  await expect(detail.getByTestId("quick-add-btn")).toBeVisible();
});

test("a counted listing says how few are left and the basket stops at the stock; status mode is unchanged (AC3)", async ({ page }) => {
  await openListing(page, ids.oxtail);
  const detail = page.getByTestId("product-detail");
  await expect(detail.getByTestId("stock-badge")).toHaveText("Only 4 left");
  await detail.getByRole("button", { name: `Add Oxtail ${slug} to basket` }).click();
  for (let i = 0; i < 3; i += 1) await detail.getByTestId("stepper-plus").click();
  await expect(detail.getByTestId("stepper-qty")).toHaveText("4");
  await expect(detail.getByTestId("stepper-plus")).toBeDisabled();
  await expect(detail.getByTestId("stepper-limit")).toHaveText("Only 4 left");
  await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden({ timeout: 15_000 });

  await openListing(page, ids.puffPuff);
  await expect(detail.getByTestId("stock-badge")).not.toContainText("left");
  await detail.getByRole("button", { name: `Add Puff puff ${slug} to basket` }).click();
  for (let i = 0; i < 5; i += 1) await detail.getByTestId("stepper-plus").click();
  await expect(detail.getByTestId("stepper-qty")).toHaveText("6");
  await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden({ timeout: 15_000 });

  await page.goto(`/cart?store=${slug}`);
  const oxtail = page.getByRole("listitem").filter({ hasText: `Oxtail ${slug}` });
  await expect(oxtail.getByTestId("line-stock-left")).toHaveText("Only 4 left");
  await expect(oxtail.getByTestId("stepper-plus")).toBeDisabled();
  await expect(page.getByRole("listitem").filter({ hasText: `Puff puff ${slug}` }).getByTestId("stepper-qty")).toHaveText("6");

  // The stock drops under the basket line (another order took two): the basket says so.
  await scoped((tx) => tx.listing.update({ where: { id: ids.oxtail }, data: { qty: 2 } }));
  await page.reload();
  await expect(oxtail).toContainText("Only 2 left. Reduce the quantity.");
});
