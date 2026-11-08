import { storeUrl } from "./urls";
import { addItemToCart } from "./checkout-helpers";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";

const base = storeUrl("mama-ngozi");

async function fillBasket(page: Page) {
  await addItemToCart(page);
  await page.goto(`${base}/cart`);
}

test.describe("Customer journey demo", () => {
  test.use({ reducedMotion: "reduce" });

  test("basket swap preference survives reload, pickup payment leads to tracking and swap approval", async ({
    page,
  }) => {
    await fillBasket(page);
    await page
      .getByRole("button", { name: /Replace with/ })
      .first()
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Let the store suggest a swap" })
      .click();
    await expect(
      page.getByRole("button", { name: /Replace with Store suggests/ }),
    ).toBeVisible({ timeout: 10000 });
    await page.reload();
    await expect(
      page.getByRole("button", { name: /Replace with Store suggests/ }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: /^Checkout/ })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Test payment" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Pickup.*Free/ }).click();
    await page.getByLabel("Full name").fill("Ada Demo");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Email (required)").fill("ada@example.test");
    await page.getByRole("button", { name: /Place demo order/ }).click();
    await expect(page).toHaveURL(/\/order\/[a-f0-9-]{36}\?placed=1/);
    await expect(
      page.getByRole("heading", { name: "Order placed", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("storefront-header").getByTestId("cart-count"),
    ).toHaveText("0");
    await page.getByRole("link", { name: "Track order", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Order progress" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Demo: advance order" }).click();
    await expect(
      page.getByRole("heading", { name: "Store accepted", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Demo: advance order" }).click();
    const orderUrl = page.url();
    await page.goto(`${orderUrl}/substitutions`);
    await expect(
      page.getByRole("heading", { name: "Your substitutions" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Swap", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Swap accepted" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("status").filter({ hasText: "Swap accepted" }),
    ).toBeVisible();
  });

  test("failed payment keeps the cart and can be retried", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${base}/categories/spices-and-seasonings`);
    const count = page.getByTestId("storefront-header").getByTestId("cart-count");
    const card = page.getByTestId("listing-card").filter({ hasText: "Suya Spice" }).first();
    await card.getByTestId("quick-add-btn").click();
    await expect(card.getByTestId("stepper-qty")).toHaveText("1");
    const plus = card.getByTestId("stepper-plus");
    for (let i = 0; i < 9; i += 1) await plus.click();
    await expect(
      page.getByTestId("storefront-header").locator("[data-cart-pending]"),
    ).toBeHidden({ timeout: 20000 });
    if ((await count.textContent()) !== "10") {
      await plus.click();
      await expect(
        page.getByTestId("storefront-header").locator("[data-cart-pending]"),
      ).toBeHidden({ timeout: 20000 });
    }
    await expect(count).toHaveText("10");
    await page.goto(`${base}/cart`);
    await page
      .getByRole("link", { name: /^Checkout/ })
      .first()
      .click();
    await page.getByLabel("Full name").fill("Ada Demo");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Demo outcome").selectOption("declined");
    await page.getByRole("button", { name: /Place demo order/ }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: /declined/ }),
    ).toContainText("Test payment declined");
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(
      page.getByTestId("storefront-header").getByTestId("cart-count"),
    ).toHaveText("10");
    await page.getByLabel("Demo outcome").selectOption("success");
    await page.getByRole("button", { name: /Place demo order/ }).click();
    await expect(page).toHaveURL(/\?placed=1$/);
  });

  test("demo gate is open: gated pages serve checkout, not a closed-flow notice", async ({
    page,
  }) => {
    await page.goto(`${base}/checkout`);
    await expect(
      page.getByRole("heading", { name: "Checkout opens soon" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Checkout" }),
    ).toBeVisible();
  });
});

test("store delivery payment with a confirmed address leads to tracking", async ({ page }) => {
  const slug = `delivery-${Date.now().toString(36)}`;
  const name = `Delivery Yam ${slug}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Delivery Lane",
      themePreset: "palm-and-shea",
      stripeOnboardingStatus: "complete",
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
    },
  });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      const listing = await tx.listing.create({
        data: {
          storeId: store.id,
          customName: name,
          price: 4000,
          stockMode: "unlimited",
          frozen: false,
          perishable: false,
        },
      });
      await tx.listingVariant.create({
        data: { listingId: listing.id, label: "Each", price: 4000, weightG: 200 },
      });
    });
    await page.context().addCookies([{
      name: "e2e_stripe_harness",
      value: "1",
      url: `http://localhost:${process.env.E2E_PORT || "3000"}`,
    }]);
    await page.goto(`/?store=${slug}`);
    await page.getByRole("button", { name: `Add ${name} to cart` }).click();
    await page.goto(`/checkout?store=${slug}`);
    await page.getByRole("button", { name: /Store delivery/ }).click();
    await page.getByLabel("Street address").fill("3700 Main St");
    await page.getByLabel("City").fill("Houston");
    await page.getByLabel("State").fill("TX");
    await page.getByLabel("ZIP").fill("77002");
    await page.getByRole("button", { name: "Confirm address" }).click();
    await expect(page.getByText(/3700 MAIN ST/)).toBeVisible();
    await page.getByLabel("Full name").fill("Ada Buyer");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Email (required)").fill("ada-delivery@example.com");
    const pay = page.getByRole("button", { name: /Pay · \$49\.00/ });
    await expect(pay).toBeVisible();
    await pay.click();
    await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 20_000 });
    const order = await prisma.order.findFirst({ where: { storeId: store.id } });
    expect(order?.fulfillment).toBe("store-delivery");
    expect(order?.deliveryFeeCents).toBe(500);
  } finally {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
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
