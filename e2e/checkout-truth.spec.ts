import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";

// #750: the basket and checkout name only what the store offers, at its real fees, with no dead tip control.
const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });

async function laneStore(slug: string, offer: { delivery: boolean; courier: boolean }) {
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Truth Lane",
      themePreset: "palm-and-shea",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      storeDeliveryEnabled: offer.delivery,
      storeDeliveryFeeCents: 450,
      deliveryRadiusMi: 8,
      minimumOrderCents: 0,
      addressLine1: "8400 Park Place Blvd",
      city: "Houston",
      state: "TX",
      zip: "77017",
      phone: "+17135550100",
      lat: 29.693857800118,
      lng: -95.266257879374,
      uberLocationId: offer.courier ? `e2e-org-${slug}` : null,
    },
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    if (offer.courier) await tx.storeSubscription.create({ data: { storeId: store.id, plan: "pro", status: "active" } });
    const listing = await tx.listing.create({
      data: { storeId: store.id, customName: `Truth Yam ${slug}`, price: 4000, stockMode: "unlimited", frozen: false, perishable: false },
    });
    await tx.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: 4000, weightG: 900 } });
  });
  return store;
}

async function dropStore(storeId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await tx.cartLine.deleteMany({ where: { storeId } });
    await tx.cart.deleteMany({ where: { storeId } });
    await tx.listingVariant.deleteMany({ where: { listing: { storeId } } });
    await tx.listing.deleteMany({ where: { storeId } });
    await tx.storeSubscription.deleteMany({ where: { storeId } });
    await tx.auditLog.deleteMany({ where: { storeId } });
  });
  await prisma.store.delete({ where: { id: storeId } });
}

async function addTheYam(page: Page, slug: string) {
  await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: `http://localhost:${process.env.E2E_PORT || "3000"}` }]);
  const add = page.getByRole("button", { name: `Add Truth Yam ${slug} to basket` });
  await expect(async () => {
    await page.goto(`/?store=${slug}`);
    await expect(add).toBeVisible();
  }).toPass({ timeout: 20_000 });
  await add.click();
  await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
  await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();
}

test.afterAll(() => prisma.$disconnect());

test("the basket names store delivery at its fee and courier as quoted at checkout, never a simulated price (#750)", async ({ page }) => {
  test.setTimeout(90_000);
  const slug = `truth-d-${Date.now().toString(36)}`;
  const store = await laneStore(slug, { delivery: true, courier: true });
  try {
    await addTheYam(page, slug);
    await page.goto(`/cart?store=${slug}`);
    const summary = page.locator("section.flow-card").filter({ has: page.getByRole("heading", { name: "Basket summary" }) });
    await expect(summary).toContainText("Store delivery from $4.50");
    await expect(summary).toContainText("courier quoted at checkout");
    await expect(summary).not.toContainText("simulated");
    await expect(summary).not.toContainText("$6.99");
  } finally {
    await dropStore(store.id);
  }
});

test("a pickup-only basket mentions no delivery option (#750)", async ({ page }) => {
  test.setTimeout(90_000);
  const slug = `truth-p-${Date.now().toString(36)}`;
  const store = await laneStore(slug, { delivery: false, courier: false });
  try {
    await addTheYam(page, slug);
    await page.goto(`/cart?store=${slug}`);
    const summary = page.locator("section.flow-card").filter({ has: page.getByRole("heading", { name: "Basket summary" }) });
    await expect(summary).toContainText("Estimated for pickup.");
    await expect(summary).not.toContainText(/delivery|courier|simulated|\$6\.99/i);
  } finally {
    await dropStore(store.id);
  }
});

test("checkout is headed Checkout, shows no tip control, and keeps Place order off after a failed address check (#750)", async ({ page }) => {
  test.setTimeout(120_000);
  const slug = `truth-c-${Date.now().toString(36)}`;
  const store = await laneStore(slug, { delivery: true, courier: true });
  try {
    await addTheYam(page, slug);
    await expect(async () => {
      await page.goto(`/checkout?store=${slug}`);
      await expect(page.getByRole("button", { name: /^Courier/ })).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await expect.soft(page.locator(".flow-heading h1")).toHaveText("Checkout");

    for (const option of [/^Store delivery/, /^Courier/]) {
      await page.getByRole("button", { name: option }).click();
      await expect(page.getByLabel("Street address")).toBeVisible();
      await expect.soft(page.getByRole("heading", { name: "A thank-you for your driver" })).toHaveCount(0);
      await expect.soft(page.getByRole("button", { name: "15%" })).toHaveCount(0);
      await expect.soft(page.getByText(/your tip/i)).toHaveCount(0);
      await expect.soft(page.locator("#review")).not.toContainText(/\bTip\b/);
    }

    await page.getByRole("button", { name: /^Store delivery/ }).click();
    const pay = page.getByRole("button", { name: /Place order/ });
    await expect(pay).toBeEnabled({ timeout: 15_000 });
    // City, State and ZIP left empty: the check fails.
    await page.getByLabel("Street address").fill("7500 Bellfort Ave");
    await page.getByRole("button", { name: "Confirm address" }).click();
    await expect(page.locator("#fulfillment").getByRole("alert")).toBeVisible({ timeout: 15_000 });
    await expect(pay).toBeDisabled();
    await expect(page.getByText("Confirm your address to place the order.")).toBeVisible();

    await page.getByLabel("Street address").fill("3700 Main St");
    await page.getByLabel("City").fill("Houston");
    await page.getByLabel("State").fill("TX");
    await page.getByLabel("ZIP").fill("77002");
    await expect(pay).toBeDisabled();
    await page.getByRole("button", { name: "Confirm address" }).click();
    await expect(page.getByRole("status").filter({ hasText: /7\.5 mi/ })).toBeVisible({ timeout: 15_000 });
    await expect(pay).toBeEnabled({ timeout: 15_000 });
  } finally {
    await dropStore(store.id);
  }
});
