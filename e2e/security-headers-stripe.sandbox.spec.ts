import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";

const key = process.env.STRIPE_PUBLISHABLE_KEY?.trim();

test("real Payment Element renders under the report-only policy with zero violations", async ({ page }) => {
  test.skip(!key, "STRIPE_PUBLISHABLE_KEY is not set");
  const slug = `csp-stripe-${Date.now().toString(36)}`;
  const name = `Csp Yam ${slug}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "CSP Stripe",
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

    await page.addInitScript(() => {
      const target = window as unknown as { __csp?: string[] };
      target.__csp = [];
      window.addEventListener("securitypolicyviolation", (event) => {
        target.__csp?.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    await page.goto(`/?store=${slug}`);
    await page.getByRole("button", { name: `Add ${name} to cart` }).click();
    const cart = page.getByRole("button", { name: "Shopping cart" }).first();
    await expect(cart.getByTestId("cart-count")).toHaveText("1");
    await expect(cart).not.toHaveAttribute("data-cart-pending");
    await page.goto(`/checkout?store=${slug}`);
    await expect(page.locator("iframe[src*='js.stripe.com']:visible").first()).toBeVisible({ timeout: 20_000 });
    const seen = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
    expect(seen).toEqual([]);
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
