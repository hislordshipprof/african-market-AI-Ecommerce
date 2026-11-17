import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { sealBusinessToken } from "../src/lib/whatsapp/token-box";

const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const OPT_IN = "Get order updates on WhatsApp";

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  const contact = page.locator("#contact");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [["1280px", { width: 1280, height: 900 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      await contact.scrollIntoViewIfNeeded();
      await contact.screenshot({ path: `${SHOTS}/560-${name}-${scheme}-${label}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

// WHATSAPP_TOKEN_KEY comes from .env.e2e, which ci.yml does not load yet (as #558's spec).
test.skip(process.env.GITHUB_ACTIONS === "true", "ci.yml lacks the #558 WhatsApp env");

test("checkout offers WhatsApp updates only at a store with a registered number, and keeps the tick on the order (#560)", async ({ page }) => {
  test.setTimeout(90_000);
  const slug = `wa560-${Date.now().toString(36)}`;
  const name = `WhatsApp Yam ${slug}`;
  const phoneNumberId = String(8_500_000_000 + Number(String(Date.now()).slice(-9)));
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "WhatsApp Lane",
      themePreset: "palm-and-shea",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      minimumOrderCents: 0,
      addressLine1: "8400 Park Place Blvd",
      city: "Houston",
      state: "TX",
      zip: "77017",
    },
  });
  const asStore = <T,>(fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      return fn(tx);
    });
  try {
    await asStore(async (tx) => {
      const listing = await tx.listing.create({
        data: { storeId: store.id, customName: name, price: 4000, stockMode: "unlimited", frozen: false, perishable: false },
      });
      await tx.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: 4000, weightG: 200 } });
    });
    await page.context().addCookies([{
      name: "e2e_stripe_harness",
      value: "1",
      url: `http://localhost:${process.env.E2E_PORT || "3000"}`,
    }]);
    const addButton = page.getByRole("button", { name: `Add ${name} to basket` });
    await expect(async () => {
      await page.goto(`/?store=${slug}`);
      await expect(addButton).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await addButton.click();
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
    await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();

    // No number: no offer.
    await page.goto(`/checkout?store=${slug}`);
    await expect(page.getByLabel("Phone number (required)")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(OPT_IN)).toHaveCount(0);

    const sealedToken = sealBusinessToken("e2e-business-token", { storeId: store.id, phoneNumberId });
    await asStore((tx) => tx.$executeRaw`
      INSERT INTO store_whatsapp_numbers (id, store_id, waba_id, phone_number_id, display_number, status, coexistence, business_token)
      VALUES (${crypto.randomUUID()}, ${store.id}, '102938475610', ${phoneNumberId}, '+14045550188', 'registered', true, ${sealedToken})
    `);
    await page.reload();
    const tick = page.getByLabel(OPT_IN);
    await expect(tick).toBeVisible({ timeout: 20_000 });
    await expect(tick).not.toBeChecked();
    await page.getByLabel("Full name").fill("Ada Buyer");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Email (required)").fill("ada-whatsapp@example.com");
    await tick.check();
    await shoot(page, "checkout-opt-in");

    const pay = page.getByRole("button", { name: /^Place order/ });
    await expect(pay).toBeEnabled({ timeout: 15_000 });
    await pay.click();
    await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 20_000 });
    const order = await asStore((tx) => tx.order.findFirst({ where: { storeId: store.id } }));
    expect(order?.whatsappOptInAt).toBeInstanceOf(Date);
    const rows = await asStore((tx) => tx.notificationLog.findMany({ where: { orderId: order!.id, event: "placed" } }));
    expect(rows.map((row) => row.channel).sort()).toEqual(["email", "push", "sms", "whatsapp"]);
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
      await tx.$executeRaw`DELETE FROM store_whatsapp_numbers WHERE store_id = ${store.id}`;
    });
    await prisma.store.delete({ where: { id: store.id } });
    await prisma.$disconnect();
  }
});
