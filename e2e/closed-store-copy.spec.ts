import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { storeUrl } from "./urls";

const ZONE = "America/Chicago";
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** Open only tomorrow (store time), so the store is closed now at any hour and the next opening is tomorrow 9:00 AM. */
function tomorrowOnlyHours(now: Date) {
  const weekday = (date: Date) => date.toLocaleDateString("en-US", { timeZone: ZONE, weekday: "long" }).toLowerCase();
  const tomorrow = weekday(new Date(now.getTime() + 24 * 60 * 60_000));
  const hours = Object.fromEntries(DAYS.map((day) => [day, day === tomorrow ? "9:00 AM - 5:00 PM" : null]));
  const short = new Date(now.getTime() + 24 * 60 * 60_000).toLocaleDateString("en-US", { timeZone: ZONE, weekday: "short" });
  return { hours, opensAt: `${short} 9:00 AM CT` };
}

test("cart and checkout say when a closed store opens and when the order is ready (#684)", async ({ page }) => {
  test.setTimeout(90_000);
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const { hours, opensAt } = tomorrowOnlyHours(new Date());
  const slug = `closed-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Closed Copy Market",
      themePreset: "palm-and-shea",
      status: "active",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      prepTimeMinutes: 30,
      timezone: ZONE,
      hours,
      minimumOrderCents: 0,
    },
  });
  const origin = storeUrl(slug);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      const listing = await tx.listing.create({
        data: { storeId: store.id, customName: "Closed Copy Egusi", price: 1200, stockMode: "unlimited", frozen: false, perishable: false },
      });
      await tx.listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price: 1200, weightG: 454 } });
    });

    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: origin }]);
    await page.goto(`${origin}/`);
    const card = page.getByTestId("listing-card").filter({ hasText: "Closed Copy Egusi" }).first();
    await card.getByTestId("quick-add-btn").click();
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
    await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden({ timeout: 20_000 });

    await page.goto(`${origin}/cart`);
    await expect(page.getByText(`Closed now · opens ${opensAt} · ready about 9:30 AM`)).toBeVisible();

    await page.goto(`${origin}/checkout`);
    const notice = page.locator("p", { hasText: "The store is closed. Order now to join the queue." });
    await expect(notice).toContainText(`Opens ${opensAt}`);
    await expect(notice).toContainText("ready about 9:30 AM");
    await expect(page.getByText(`The store opens ${opensAt}. Your card is held now`)).toBeVisible();
  } finally {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
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
