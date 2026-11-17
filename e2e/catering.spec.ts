import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";

const ALL_DAY = [{ start: 0, end: 1440 }];
const HOUR = 60 * 60_000;

test("a catering tray goes in at its minimum, takes a pickup time past its lead, and tracking shows the time (#571)", async ({ page }) => {
  test.setTimeout(120_000);
  const slug = `cater-${Date.now().toString(36)}`;
  const name = `Jollof tray ${slug}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Catering Lane",
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
      pickupSlotSettings: {
        slotMinutes: 60,
        leadMinutes: 120,
        capacity: 3,
        daysAhead: 1,
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
        data: {
          storeId: store.id, customName: name, price: 6000, stockMode: "unlimited", frozen: false, perishable: false,
          prepared: "hot", prepMinutes: 30, cateringLeadHours: 48, cateringMinQty: 2,
        },
      });
      await tx.listingVariant.create({ data: { listingId: listing.id, label: "Tray", price: 6000, weightG: 3_000 } });
    });
    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: `http://localhost:${process.env.E2E_PORT || "3000"}` }]);
    const addButton = page.getByRole("button", { name: `Add ${name} to cart` });
    await expect(async () => {
      await page.goto(`/?store=${slug}`);
      await expect(addButton).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await addButton.click();
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("2", { timeout: 15_000 });
    await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();

    await expect(async () => {
      await page.goto(`/checkout?store=${slug}`);
      await expect(page.getByLabel("Pickup time")).toBeVisible();
    }).toPass({ timeout: 20_000 });
    const pickupTime = page.getByLabel("Pickup time");
    await expect(page.getByRole("button", { name: /^ASAP/ })).toHaveCount(0);
    const earliest = await pickupTime.locator("option").first().getAttribute("value");
    expect(Date.parse(earliest!)).toBeGreaterThanOrEqual(Date.now() + 47.9 * HOUR);

    await page.getByLabel("Full name").fill("Ada Buyer");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Email (required)").fill(`ada-${slug}@example.com`);
    const pay = page.getByRole("button", { name: /Place order · .* hold/ });
    await expect(pay).toBeEnabled({ timeout: 15_000 });
    const chosen = await pickupTime.inputValue();
    await pay.click();
    await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 20_000 });
    await expect(page.getByText("Scheduled for:")).toBeVisible();
    const order = await scoped((tx) => tx.order.findFirst({ where: { storeId: store.id }, include: { lines: true } }));
    expect(order).toMatchObject({ fulfillment: "pickup", pickupSlot: chosen });
    expect(order!.lines[0]!.qtyOrdered).toBe(2);
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
      await tx.listingVariant.deleteMany({ where: { listing: { storeId: store.id } } });
      await tx.listing.deleteMany({ where: { storeId: store.id } });
      await tx.auditLog.deleteMany({ where: { storeId: store.id } });
    });
    await prisma.store.delete({ where: { id: store.id } });
    await prisma.$disconnect();
  }
});
