import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { E2E_PORT } from "./urls";

const apiBase = `http://localhost:${E2E_PORT}`;

async function asStore<T>(prisma: PrismaClient, storeId: string, work: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return work(tx);
  });
}

async function addToCart(page: Page, slug: string, name: string) {
  await expect(async () => {
    await page.goto(`/?store=${slug}`);
    await expect(page.getByRole("button", { name: `Add ${name} to basket` })).toBeVisible();
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: `Add ${name} to basket` }).click();
  await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
  await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();
}

// Guest checkout on the fake Stripe harness: the code goes on the basket, checkout holds the
// discounted total, and the order and its tracking page carry the discount (#557).
test("#557: a store code applied on the basket lowers the hold at checkout and shows on the order", async ({ page }) => {
  test.setTimeout(180_000);
  const slug = `coupon-${Date.now().toString(36)}`;
  const name = `Coupon Yam ${slug}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const owner = await prisma.user.create({
    data: { id: crypto.randomUUID(), email: `e2e-${slug}@test.example`, name: "Coupon Owner", emailVerified: true },
  });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Coupon Lane",
      themePreset: "palm-and-shea",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      minimumOrderCents: 0,
      addressLine1: "8400 Park Place Blvd",
      city: "Houston",
      state: "TX",
      zip: "77017",
    },
  });
  try {
    await asStore(prisma, store.id, async (tx) => {
      const listing = await tx.listing.create({
        data: { storeId: store.id, customName: name, price: 4000, stockMode: "unlimited", frozen: false, perishable: false },
      });
      await tx.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: 4000, weightG: 200 } });
      await tx.storeCoupon.create({
        data: { storeId: store.id, code: "SAVE20", kind: "percent", percentOff: 20, startsAt: new Date("2026-01-01T00:00:00Z"), createdById: owner.id },
      });
    });
    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: apiBase }]);
    await addToCart(page, slug, name);

    await page.goto("/cart");
    const field = page.getByTestId("coupon-field");
    await field.getByLabel("Promo code").fill("NOTACODE");
    await field.getByRole("button", { name: "Apply" }).click();
    await expect(field.getByText("That code isn't valid at this store.")).toBeVisible();
    await field.getByLabel("Promo code").fill("save20");
    await field.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByTestId("applied-coupon")).toContainText("SAVE20 applied");
    await expect(page.getByText("Promo SAVE20")).toBeVisible();

    // $40.00 − 20% = $32.00; fee 3% = 96¢ → 99¢ minimum; total $32.99; buffer $3.20; hold $36.19.
    await page.goto("/checkout");
    await expect(page.getByRole("button", { name: "Place order · $36.19 hold" })).toBeEnabled({ timeout: 15_000 });
    await expect(page.locator("#review").getByText("Promo SAVE20")).toBeVisible();
    await page.getByLabel("Full name").fill("Ada Coupon");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Email (required)").fill(`ada-${slug}@example.com`);
    await page.getByRole("button", { name: /^Place order/ }).click();
    await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 30_000 });
    await expect(page.getByText("Promo SAVE20")).toBeVisible();

    const order = await asStore(prisma, store.id, (tx) => tx.order.findFirstOrThrow({ where: { storeId: store.id } }));
    expect(order).toMatchObject({ discountCents: 800, totalCents: 3299, totalAuthorizedCents: 3619, couponCustomerKey: `email:ada-${slug}@example.com` });
  } finally {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.notificationLog.deleteMany({ where: { storeId: store.id } });
      await tx.stockEvent.deleteMany({ where: { storeId: store.id } });
      await tx.orderLine.deleteMany({ where: { storeId: store.id } });
      await tx.order.deleteMany({ where: { storeId: store.id } });
      await tx.customer.deleteMany({ where: { storeId: store.id } });
      await tx.cartLine.deleteMany({ where: { storeId: store.id } });
      await tx.cart.deleteMany({ where: { storeId: store.id } });
      await tx.storeCoupon.deleteMany({ where: { storeId: store.id } });
      await tx.listingVariant.deleteMany({ where: { listing: { storeId: store.id } } });
      await tx.listing.deleteMany({ where: { storeId: store.id } });
      await tx.auditLog.deleteMany({ where: { storeId: store.id } });
    }).catch(() => undefined);
    await prisma.store.deleteMany({ where: { id: store.id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: owner.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
