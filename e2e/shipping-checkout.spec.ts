import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { signShippoWebhook } from "../src/lib/shipping/shippo";

test("a shopper ships dry goods to another state at the carrier's rate (#567), and the carrier's first scan ships it (#568)", async ({ page }) => {
  test.setTimeout(120_000);
  const slug = `ship-${Date.now().toString(36)}`;
  const items = [`Ship Egusi ${slug}`, `Ship Garri ${slug}`];
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  // The seed opens Maryland for shipping (prisma/seed.ts, seedShipping).
  const settings = await prisma.platformSettings.findUniqueOrThrow({ where: { id: "platform" } });
  expect(settings.shippingStates).toContain("MD");
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Ship Lane",
      themePreset: "palm-and-shea",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      deliveryRadiusMi: 8,
      minimumOrderCents: 0,
      addressLine1: "8400 Park Place Blvd",
      city: "Houston",
      state: "TX",
      zip: "77017",
      phone: "+17135550100",
      lat: 29.693857800118,
      lng: -95.266257879374,
      shippingHandlingDays: 2,
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
      for (const [name, weightG] of [[items[0], 454], [items[1], 2268]] as const) {
        const listing = await tx.listing.create({
          data: { storeId: store.id, customName: name, price: 1500, stockMode: "unlimited", frozen: false, perishable: false, shippable: true },
        });
        await tx.listingVariant.create({ data: { listingId: listing.id, label: "Bag", price: 1500, weightG } });
      }
    });
    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: `http://localhost:${process.env.E2E_PORT || "3000"}` }]);
    const count = page.getByTestId("storefront-header").getByTestId("cart-count");
    await expect(async () => {
      await page.goto(`/?store=${slug}`);
      await expect(page.getByRole("button", { name: `Add ${items[0]} to basket` })).toBeVisible();
    }).toPass({ timeout: 20_000 });
    for (const [i, name] of items.entries()) {
      await page.getByRole("button", { name: `Add ${name} to basket` }).click();
      await expect(count).toHaveText(String(i + 1));
      await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();
    }

    const ship = page.getByRole("button", { name: /^Ship/ });
    await expect(async () => {
      await page.goto(`/checkout?store=${slug}`);
      await expect(ship).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await ship.click();
    await expect(page.getByText("Enter your shipping address to see the shipping rate.")).toBeVisible({ timeout: 15_000 });
    // Before any address: the states it ships to, in words (#750).
    await expect(page.getByText(/^Ships to .*Maryland/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "A thank-you for your driver" })).toHaveCount(0);
    await expect(page.getByLabel("Leave at door")).toHaveCount(0);

    await page.getByLabel("Full name").fill("Ada Buyer");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Email (required)").fill(`ada-${slug}@example.com`);
    // About 1,300 miles from the store: far outside its 8-mile delivery radius.
    await page.getByLabel("Street address").fill("8505 Fenton St");
    await page.getByLabel("City").fill("Silver Spring");
    await page.getByLabel("State").fill("MD");
    await page.getByLabel("ZIP").fill("20910");
    await page.getByRole("button", { name: "Confirm address" }).click();
    await expect(page.getByRole("status").filter({ hasText: "8505 FENTON ST" })).toBeVisible();

    const rate = page.getByRole("status").filter({ hasText: "USPS Ground Advantage" });
    await expect(rate).toBeVisible({ timeout: 15_000 });
    await expect(rate).toContainText("Arrives in about 7 business days");
    await expect(rate).toContainText("no markup");
    const fee = (await ship.textContent())?.match(/\$\d+\.\d{2}/)?.[0];
    expect(fee).toBeTruthy();
    await expect(page.locator("#review")).toContainText("Shipping · USPS");

    const pay = page.getByRole("button", { name: /Place order · .* hold/ });
    await expect(pay).toBeEnabled({ timeout: 15_000 });
    await pay.click();
    await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 20_000 });
    const status = page.getByRole("region", { name: "Order placed" });
    await expect(status).toContainText(/Fulfillment:?\s*Shipping/);
    await expect(status).toContainText(/Carrier:?\s*USPS Ground Advantage/);
    await expect(page.locator(".flow-fee", { hasText: "Shipping" }).getByLabel(fee!)).toBeVisible();

    const order = await scoped((tx) => tx.order.findFirst({ where: { storeId: store.id } }));
    expect(order).toMatchObject({ fulfillment: "ship", shippingCarrier: "USPS", deliveryState: "MD" });
    expect(order?.deliveryFeeCents).toBe(Math.round(Number(fee?.slice(1)) * 100));

    // #568: the label was bought at Ready (the e2e server has no proof bucket, so the row stands in for it); the
    // carrier's first scan arrives as a signed Shippo webhook and the shopper's page reads Shipped with the carrier link.
    const labelId = `txn_e2e_${slug.replace(/[^a-z0-9]/g, "")}`;
    const trackingUrl = "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490";
    await scoped((tx) => tx.order.update({
      where: { id: order!.id },
      data: { status: "READY", shippingLabelStatus: "bought", shippingLabelId: labelId, shippingTrackingNumber: "9400111899223197428490", shippingTrackingUrl: trackingUrl },
    }));
    const body = JSON.stringify({ event: "track_updated", test: true, data: { transaction: labelId, tracking_status: { object_id: `ts_${slug}`, status: "TRANSIT" } } });
    const unsigned = await page.request.post("/api/webhooks/shippo", { data: body, headers: { "content-type": "application/json" } });
    expect(unsigned.status()).toBe(401);
    const signed = await page.request.post("/api/webhooks/shippo", {
      data: body,
      headers: { "content-type": "application/json", "shippo-auth-signature": signShippoWebhook(body, process.env.SHIPPO_WEBHOOK_SECRET ?? "e2e-shippo-webhook") },
    });
    expect(await signed.json()).toEqual({ received: true, recorded: true });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Shipped", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "9400111899223197428490" })).toHaveAttribute("href", trackingUrl);
    const proof = process.env.PROOF_DIR;
    if (proof) {
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await page.screenshot({ path: `${proof}/order-shipped-${width}-${scheme}.png`, fullPage: true });
        }
      }
    }
  } finally {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.notificationLog.deleteMany({ where: { storeId: store.id } });
      await tx.deliveryEvent.deleteMany({ where: { storeId: store.id } });
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
