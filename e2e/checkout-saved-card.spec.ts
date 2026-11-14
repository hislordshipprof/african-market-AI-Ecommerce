import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { SAVED_CARD_UNAVAILABLE } from "../src/lib/customer-account/consent";
import { E2E_PORT } from "./urls";

const apiBase = `http://localhost:${E2E_PORT}`;

// The harness confirms through /api/e2e/fake-confirm, so this drives the app's own Pay branches
// (new card, saved card, fallback) in a browser. Stripe.js and 3DS are not in this loop.
test("signed-in checkout: save tick starts unticked, a saved card is reused, a removed card falls back", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const slug = `savedcard-${Date.now().toString(36)}`;
  const name = `Saved Card Yam ${slug}`;
  const email = `e2e-${slug}@test.example`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Saved Card Lane",
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
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      const listing = await tx.listing.create({
        data: { storeId: store.id, customName: name, price: 4000, stockMode: "unlimited", frozen: false, perishable: false },
      });
      await tx.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: 4000, weightG: 200 } });
    });

    const signup = await request.post(`${apiBase}/api/auth/sign-up/email`, {
      data: { email, password: "E2eTestPass-123!", name: "Ada Saver" },
    });
    expect(signup.ok(), await signup.text()).toBe(true);
    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: apiBase }]);
    await expect(async () => {
      await page.goto(`/?store=${slug}`);
      await expect(page.getByRole("button", { name: `Add ${name} to cart` })).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await page.goto("/account/sign-in");
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send sign-in link" }).click();
    await expect(page.locator("[data-slot='card-title']")).toContainText("Check your email", { timeout: 10_000 });
    const tokenRes = await request.get(`${apiBase}/api/e2e/magic-link-token?email=${encodeURIComponent(email)}`);
    const { token } = await tokenRes.json();
    await page.goto(`/api/auth/magic-link/verify?token=${token}&callbackURL=/account`);
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible({ timeout: 15_000 });

    const saveTick = page.getByRole("checkbox", { name: /Save this card for next time/ });
    const savedCard = page.getByRole("radio", { name: /visa ending in 4242/ });

    // 1. The rendered tick starts unticked; ticking and unticking at once saves nothing.
    await openCheckout(page, name);
    await expect(saveTick).toBeVisible();
    await expect(saveTick).not.toBeChecked();
    await saveTick.check();
    await expect(saveTick).toBeChecked();
    await saveTick.uncheck();
    await expect(saveTick).not.toBeChecked();
    await pay(page);
    await page.goto("/account");
    await expect(page.getByText("No saved cards yet.")).toBeVisible();

    // 2. A ticked purchase saves the card.
    await openCheckout(page, name);
    await expect(saveTick).not.toBeChecked();
    await saveTick.check();
    await pay(page);
    await page.goto("/account");
    await expect(page.getByTestId("account-card-list").getByText("visa ending in 4242")).toBeVisible();

    // 3. The next checkout pre-selects the saved card and pays with it.
    await openCheckout(page, name);
    await expect(savedCard).toBeChecked();
    await expect(saveTick).toHaveCount(0);
    await pay(page);

    // 4. A card removed after the page loaded falls back to the card form, unticked.
    await openCheckout(page, name);
    await expect(savedCard).toBeChecked();
    const account = await page.context().newPage();
    await account.goto("/account");
    const cards = account.getByTestId("account-card-list");
    await cards.getByRole("button", { name: "Remove" }).click();
    await expect(cards.getByText("No saved cards yet.")).toBeVisible();
    await account.close();
    await fillContact(page);
    await page.getByRole("button", { name: /^Place order/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: SAVED_CARD_UNAVAILABLE })).toBeVisible({ timeout: 15_000 });
    await expect(savedCard).not.toBeChecked();
    await expect(page.getByText("Card entry is simulated for this test.")).toBeVisible();
    await expect(saveTick).not.toBeChecked();
    await pay(page);
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
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  }
});

async function openCheckout(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: `Add ${name} to cart` }).click();
  await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
  await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();
  await page.goto("/checkout");
  await expect(page.getByRole("button", { name: /^Place order/ })).toBeEnabled({ timeout: 15_000 });
}

async function fillContact(page: Page) {
  await page.getByLabel("Full name").fill("Ada Saver");
  await page.getByLabel("Phone number (required)").fill("2025550100");
  await page.getByLabel("Email (required)").fill("ada-saver@example.com");
}

async function pay(page: Page) {
  await fillContact(page);
  await page.getByRole("button", { name: /^Place order/ }).click();
  await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 30_000 });
}
