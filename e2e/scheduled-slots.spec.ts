import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";

const ALL_DAY = [{ start: 0, end: 1440 }];

test("a heavy cart books a scheduled store delivery slot, and a slot that fills is refused with fresh times (#565)", async ({ page }) => {
  test.setTimeout(120_000);
  const slug = `slots-${Date.now().toString(36)}`;
  const name = `Heavy Yam ${slug}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Slot Lane",
      themePreset: "palm-and-shea",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      timezone: "America/Chicago",
      pickupEnabled: true,
      storeDeliveryEnabled: true,
      storeDeliveryFeeCents: 500,
      deliveryRadiusMi: 8,
      minimumOrderCents: 0,
      addressLine1: "8400 Park Place Blvd",
      city: "Houston",
      state: "TX",
      zip: "77017",
      lat: 29.693857800118,
      lng: -95.266257879374,
      storeDeliverySlotSettings: {
        slotMinutes: 60,
        leadMinutes: 120,
        capacity: 1,
        daysAhead: 2,
        closedDates: [],
        windows: [ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY],
      },
    },
  });
  const scoped = <T>(run: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      return run(tx);
    });
  try {
    await scoped(async (tx) => {
      const listing = await tx.listing.create({
        data: { storeId: store.id, customName: name, price: 4000, stockMode: "unlimited", frozen: false, perishable: false },
      });
      // 25 kg: over the 50 lb courier limit (spec D4).
      await tx.listingVariant.create({ data: { listingId: listing.id, label: "Sack", price: 4000, weightG: 25_000 } });
    });
    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: `http://localhost:${process.env.E2E_PORT || "3000"}` }]);
    const addButton = page.getByRole("button", { name: `Add ${name} to cart` });
    await expect(async () => {
      await page.goto(`/?store=${slug}`);
      await expect(addButton).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await addButton.click();
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
    await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();
    await expect(async () => {
      await page.goto(`/checkout?store=${slug}`);
      await expect(page.getByRole("button", { name: /Store delivery/ })).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await expect(page.getByText(/Order weight: 55\.1 lb/)).toBeVisible();

    await page.getByRole("button", { name: /Store delivery/ }).click();
    const deliveryTime = page.getByLabel("Delivery time");
    await expect(deliveryTime).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^ASAP/ })).toHaveCount(0);
    await expect(deliveryTime.locator("option").first()).toHaveText(/[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, .* C[SD]T$/);

    await page.getByLabel("Street address").fill("3700 Main St");
    await page.getByLabel("City").fill("Houston");
    await page.getByLabel("State").fill("TX");
    await page.getByLabel("ZIP").fill("77002");
    await page.getByRole("button", { name: "Confirm address" }).click();
    await expect(page.getByRole("status").filter({ hasText: /7\.5 mi/ })).toBeVisible();
    await page.getByLabel("Full name").fill("Ada Buyer");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Email (required)").fill(`ada-${slug}@example.com`);

    // Another shopper takes the chosen slot's only place while this one is on the page.
    const taken = await deliveryTime.inputValue();
    await scoped(async (tx) => {
      const customer = await tx.customer.create({ data: { storeId: store.id, name: "Other", email: "other@example.com", phone: "+12025550101" } });
      await tx.order.create({
        data: {
          storeId: store.id, number: 900, customerId: customer.id, status: "AUTHORIZED", fulfillment: "store-delivery",
          pickupSlot: taken, subtotalCents: 4000, bufferCents: 400, totalAuthorizedCents: 4900,
        },
      });
    });
    const pay = page.getByRole("button", { name: /Place order · .* hold/ });
    await expect(pay).toBeEnabled({ timeout: 15_000 });
    await pay.click();
    await expect(page.getByText("That time is no longer available. Choose another time.")).toBeVisible({ timeout: 15_000 });
    await expect(deliveryTime.locator(`option[value="${taken}"]`)).toHaveCount(0);
    const fresh = await deliveryTime.inputValue();
    expect(fresh).not.toBe(taken);

    await pay.click();
    await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 20_000 });
    const order = await scoped((tx) => tx.order.findFirst({ where: { storeId: store.id, number: { not: 900 } } }));
    expect(order).toMatchObject({ fulfillment: "store-delivery", pickupSlot: fresh, deliveryFeeCents: 500 });
  } finally {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.notificationLog.deleteMany({ where: { storeId: store.id } });
      await tx.orderLine.deleteMany({ where: { storeId: store.id } });
      await tx.order.deleteMany({ where: { storeId: store.id } });
      await tx.customer.deleteMany({ where: { storeId: store.id } });
      await tx.cartLine.deleteMany({ where: { storeId: store.id } });
      await tx.cart.deleteMany({ where: { storeId: store.id } });
      await tx.listingVariant.deleteMany({ where: { listing: { storeId: store.id } } });
      await tx.listing.deleteMany({ where: { storeId: store.id } });
      await tx.auditLog.deleteMany({ where: { storeId: store.id } });
    });
    await prisma.store.delete({ where: { id: store.id } });
    await prisma.$disconnect();
  }
});
