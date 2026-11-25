import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { E2E_PORT } from "./urls";

const apiBase = `http://localhost:${E2E_PORT}`;
const PROOF = process.env.PROOF_DIR;

/** Proof screenshots at 390 and 1280, only when PROOF_DIR is set. */
async function proof(page: Page, name: string) {
  if (!PROOF) return;
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${PROOF}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

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

type CouponStore = { slug: string; name: string; storeId: string; prisma: PrismaClient };

/** A pickup store with one item and one percent code, removed again after `run`. */
async function withCouponStore(
  opts: { minimumOrderCents: number; priceCents: number; code: string; percentOff: number },
  run: (store: CouponStore) => Promise<void>,
) {
  const slug = `coupon-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
      minimumOrderCents: opts.minimumOrderCents,
      addressLine1: "8400 Park Place Blvd",
      city: "Houston",
      state: "TX",
      zip: "77017",
    },
  });
  try {
    await asStore(prisma, store.id, async (tx) => {
      const listing = await tx.listing.create({
        data: { storeId: store.id, customName: name, price: opts.priceCents, stockMode: "unlimited", frozen: false, perishable: false },
      });
      await tx.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: opts.priceCents, weightG: 200 } });
      await tx.storeCoupon.create({
        data: { storeId: store.id, code: opts.code, kind: "percent", percentOff: opts.percentOff, startsAt: new Date("2026-01-01T00:00:00Z"), createdById: owner.id },
      });
    });
    await run({ slug, name, storeId: store.id, prisma });
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
}

async function applyCode(page: Page, code: string) {
  const field = page.getByTestId("coupon-field");
  await field.getByLabel("Promo code").fill(code);
  await field.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("applied-coupon")).toContainText(`${code} applied`);
}

// Guest checkout on the fake Stripe harness: the code goes on the basket, checkout holds the
// discounted total, and the order and its tracking page carry the discount (#557).
test("#557: a store code applied on the basket lowers the hold at checkout and shows on the order", async ({ page }) => {
  test.setTimeout(180_000);
  await withCouponStore({ minimumOrderCents: 0, priceCents: 4000, code: "SAVE20", percentOff: 20 }, async ({ slug, name, storeId, prisma }) => {
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

    const order = await asStore(prisma, storeId, (tx) => tx.order.findFirstOrThrow({ where: { storeId } }));
    expect(order).toMatchObject({ discountCents: 800, totalCents: 3299, totalAuthorizedCents: 3619, couponCustomerKey: `email:ada-${slug}@example.com` });
  });
});

// #806: the store funds the code, so its $35 minimum is on goods after the discount: $35.97 − 10% = $32.37.
test("#806: a code that takes the goods under the store minimum says how much more to add on the basket and at checkout", async ({ page }) => {
  test.setTimeout(120_000);
  await withCouponStore({ minimumOrderCents: 3500, priceCents: 3597, code: "TEN10", percentOff: 10 }, async ({ slug, name }) => {
    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: apiBase }]);
    await addToCart(page, slug, name);

    await page.goto("/cart");
    await expect(page.getByText("You've reached the minimum order.")).toBeVisible();
    await applyCode(page, "TEN10");
    await expect(page.getByText("$2.63 more to reach the $35.00 minimum").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Continue to checkout" })).toBeDisabled();
    await proof(page, "806-cart-minimum");

    await page.goto("/checkout");
    await expect(page.getByText("$2.63 more to reach the $35.00 minimum").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Place order/ })).toBeDisabled();
    await proof(page, "806-checkout-minimum");
  });
});
