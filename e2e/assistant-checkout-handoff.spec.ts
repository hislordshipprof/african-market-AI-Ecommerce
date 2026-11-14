import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { storeUrl } from "./urls";

async function scoped<T>(prisma: PrismaClient, storeId: string, run: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return run(tx);
  });
}

test("the assistant hands off to normal checkout with the pickup time pre-selected, and only Pay places the order (#247)", async ({ page }) => {
  test.setTimeout(120_000);
  const slug = `handoff-${Date.now().toString(36)}`;
  const origin = storeUrl(slug);
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Handoff Market",
      themePreset: "palm-and-shea",
      status: "active",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      prepTimeMinutes: 30,
      timezone: "America/Chicago",
      minimumOrderCents: 0,
    },
  });
  try {
    await scoped(prisma, store.id, async (tx) => {
      const listing = await tx.listing.create({
        data: { storeId: store.id, customName: "Handoff Egusi", price: 1200, stockMode: "unlimited", frozen: false, perishable: false },
      });
      await tx.listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price: 1200, weightG: 454 } });
    });
    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: origin }]);
    await page.goto(`${origin}/`);
    await page.getByTestId("assistant-launcher").click();
    const sheet = page.getByRole("dialog", { name: "Shop with AI" });
    await page.getByTestId("assistant-composer").fill("add two egusi");
    await page.getByTestId("assistant-send").click();
    await expect(sheet.getByText("Handoff Egusi").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("assistant-composer")).toBeEnabled();
    await page.getByTestId("assistant-composer").fill("I'm ready to check out");
    await page.getByTestId("assistant-send").click();

    const review = sheet.getByRole("region", { name: "Review your order" });
    await expect(review).toBeVisible({ timeout: 20_000 });
    await expect(review).toContainText("2 × Handoff Egusi");
    await expect(review).toContainText("$24.00");
    await expect(review).toContainText(/Pickup · \d{1,2}:\d{2} [AP]M C[SD]T/);
    const slotLabel = (await review.getByText(/^Pickup · /).textContent())!.replace("Pickup · ", "");
    expect(await scoped(prisma, store.id, (tx) => tx.order.count())).toBe(0);
    const cart = await scoped(prisma, store.id, (tx) => tx.cart.findFirst());
    expect(cart?.paymentIntentId).toBeNull();

    await review.getByRole("link", { name: "Review and pay" }).click();
    await expect(page).toHaveURL(/\/checkout$/);
    const pickupTime = page.locator("select").filter({ has: page.locator("option", { hasText: `Today ${slotLabel}` }) });
    await expect(pickupTime).toHaveValue(/Z$/, { timeout: 15_000 });
    await expect(pickupTime.locator("option:checked")).toHaveText(`Today ${slotLabel}`);

    await page.getByLabel("Full name").fill("Ada Buyer");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Email (required)").fill(`ada-${slug}@example.com`);
    const pay = page.getByRole("button", { name: /Place order · .* hold/ });
    await expect(pay).toBeEnabled({ timeout: 15_000 });
    await pay.click();
    await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 20_000 });
    const order = await scoped(prisma, store.id, (tx) => tx.order.findFirst());
    expect(order?.fulfillment).toBe("pickup");
    expect(order?.pickupSlot).toMatch(/Z$/);
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
