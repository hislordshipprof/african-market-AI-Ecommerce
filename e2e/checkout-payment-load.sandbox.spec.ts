import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";

const key = process.env.STRIPE_PUBLISHABLE_KEY?.trim();

// Stripe.js blocked by the network or an extension; or Stripe.js loads and the Payment Element's session does not.
const FAILURES = [
  { what: "Stripe.js", url: "https://js.stripe.com/**" },
  { what: "the Payment Element", url: /api\.stripe\.com\/v1\/elements\/sessions/ },
];

for (const failure of FAILURES) test(`when ${failure.what} fails to load, checkout says so, holds Place order and recovers on Try again (#783)`, async ({ page }) => {
  test.skip(!key, "STRIPE_PUBLISHABLE_KEY is not set");
  const slug = `pay-load-${FAILURES.indexOf(failure)}-${Date.now().toString(36)}`;
  const name = `Load Yam ${slug}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Payment Load",
      themePreset: "palm-and-shea",
      stripeOnboardingStatus: "complete",
      pickupEnabled: true,
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
          price: 500,
          stockMode: "counted",
          qty: 4,
          frozen: false,
          perishable: false,
        },
      });
      await tx.listingVariant.create({
        data: { listingId: listing.id, label: "Each", price: 500, weightG: 200 },
      });
    });

    await page.goto(`/?store=${slug}`);
    await page.getByRole("button", { name: `Add ${name} to basket` }).click();
    const cart = page.getByRole("button", { name: /in basket$|^Basket$/ }).first();
    await expect(cart.getByTestId("cart-count")).toHaveText("1");
    await expect(cart).not.toHaveAttribute("data-cart-pending");
    await page.route(failure.url, (route) => route.abort());
    await page.goto(`/checkout?store=${slug}`);
    const alert = page.getByRole("alert").filter({ hasText: "Card payment didn’t load" });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Place order/ })).toBeDisabled();
    await page.unroute(failure.url);
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("iframe[src*='js.stripe.com']:visible").first()).toBeVisible({ timeout: 20_000 });
    await expect(alert).toHaveCount(0);
  } finally {
    await page.close();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.cartLine.deleteMany({ where: { storeId: store.id } });
      await tx.cart.deleteMany({ where: { storeId: store.id } });
      await tx.listingVariant.deleteMany({ where: { listing: { storeId: store.id } } });
      await tx.listing.deleteMany({ where: { storeId: store.id } });
    });
    await prisma.store.delete({ where: { id: store.id } });
    await prisma.$disconnect();
  }
});
