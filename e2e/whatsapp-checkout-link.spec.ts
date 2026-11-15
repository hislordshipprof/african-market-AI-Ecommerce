import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { storeUrl } from "./urls";

const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const EXPIRED = "This checkout link has expired";

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [["1280px", { width: 1280, height: 900 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      await page.screenshot({ path: `${SHOTS}/559-${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

function token(): { token: string; tokenHash: string } {
  const value = randomBytes(32).toString("base64url");
  return { token: value, tokenHash: createHash("sha256").update(value).digest("hex") };
}

test("a WhatsApp checkout link opens the store's checkout with the chat's cart once, and a used or expired link lands on the expired page (#559)", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const slug = `wa559-${Date.now().toString(36)}`;
  const name = `WhatsApp Egusi ${slug}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "WhatsApp Basket",
      themePreset: "palm-and-shea",
      status: "active",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      minimumOrderCents: 0,
    },
  });
  const asStore = <T,>(fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      return fn(tx);
    });
  const origin = storeUrl(slug);
  const fresh = token();
  const stale = token();
  try {
    await asStore(async (tx) => {
      const listing = await tx.listing.create({
        data: { storeId: store.id, customName: name, price: 1200, stockMode: "unlimited", frozen: false, perishable: false },
      });
      const variant = await tx.listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price: 1200, weightG: 454 } });
      const cart = await tx.cart.create({ data: { storeId: store.id, source: "manual" } });
      await tx.cartLine.create({ data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 2, source: "ai" } });
      const hour = 60 * 60 * 1000;
      await tx.whatsAppCheckoutLink.create({
        data: { storeId: store.id, cartId: cart.id, tokenHash: fresh.tokenHash, expiresAt: new Date(Date.now() + hour) },
      });
      await tx.whatsAppCheckoutLink.create({
        data: { storeId: store.id, cartId: cart.id, tokenHash: stale.tokenHash, expiresAt: new Date(Date.now() - 1000) },
      });
    });

    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: origin }]);
    await page.goto(`${origin}/api/checkout-link/${fresh.token}`);
    await expect(page).toHaveURL(`${origin}/checkout`);
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
    // A reload in the same browser keeps the cart.
    await page.goto(`${origin}/api/checkout-link/${fresh.token}`);
    await expect(page).toHaveURL(`${origin}/checkout`);

    const other = await browser.newContext();
    const stranger = await other.newPage();
    await stranger.goto(`${origin}/api/checkout-link/${fresh.token}`);
    await expect(stranger).toHaveURL(`${origin}/checkout/link-expired`);
    await expect(stranger.getByRole("heading", { name: EXPIRED })).toBeVisible();
    await expect(stranger.getByText(name)).toHaveCount(0);
    await other.close();

    await page.context().clearCookies();
    await page.goto(`${origin}/api/checkout-link/${stale.token}`);
    await expect(page).toHaveURL(`${origin}/checkout/link-expired`);
    await expect(page.getByRole("heading", { name: EXPIRED })).toBeVisible();
    await shoot(page, "checkout-link-expired");

    expect(await asStore((tx) => tx.order.count({ where: { storeId: store.id } }))).toBe(0);
  } finally {
    await asStore(async (tx) => {
      await tx.cartLine.deleteMany({ where: { storeId: store.id } });
      await tx.cart.deleteMany({ where: { storeId: store.id } });
      await tx.listingVariant.deleteMany({ where: { listing: { storeId: store.id } } });
      await tx.listing.deleteMany({ where: { storeId: store.id } });
    });
    await prisma.store.delete({ where: { id: store.id } });
    await prisma.$disconnect();
  }
});
