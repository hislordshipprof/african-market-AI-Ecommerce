import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";
import { storeUrl } from "./urls";

const OWNER_EMAIL = "owner@mama-ngozi.test";
const OWNER_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

let origin = storeUrl("mama-ngozi");
let storeSlug = "mama-ngozi";
let sharedStripe: { stripeOnboardingStatus: string; stripeAccountId: string | null } | undefined;

function db() {
  return new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
}

test.beforeAll(async () => {
  const raw = db();
  try {
    const shared = await raw.store.findUnique({
      where: { slug: "mama-ngozi" },
      select: { id: true, stripeOnboardingStatus: true, stripeAccountId: true, timezone: true, prepTimeMinutes: true, minimumOrderCents: true },
    });
    if (!shared) throw new Error("mama-ngozi is not seeded");
    sharedStripe = {
      stripeOnboardingStatus: shared.stripeOnboardingStatus,
      stripeAccountId: shared.stripeAccountId,
    };
    const owner = await raw.user.findUnique({ where: { email: OWNER_EMAIL }, select: { id: true } });
    if (!owner) throw new Error("mama-ngozi owner is not seeded");
    const slug = `asst-h-${Date.now().toString(36)}`;
    const accountId = `acct_e2e_asst_${Date.now().toString(36)}`;
    const store = await raw.store.create({
      data: {
        slug,
        name: "Assistant Harness Market",
        themePreset: "palm-and-shea",
        status: "active",
        stripeOnboardingStatus: "complete",
        stripeAccountId: accountId,
        pickupEnabled: true,
        timezone: shared.timezone,
        prepTimeMinutes: shared.prepTimeMinutes,
        minimumOrderCents: shared.minimumOrderCents,
        hours: {
          monday: "9:00 AM - 11:59 PM",
          tuesday: "9:00 AM - 11:59 PM",
          wednesday: "9:00 AM - 11:59 PM",
          thursday: "9:00 AM - 11:59 PM",
          friday: "9:00 AM - 11:59 PM",
          saturday: "9:00 AM - 11:59 PM",
          sunday: "9:00 AM - 11:59 PM",
        },
      },
    });
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      await tx.storeMembership.create({ data: { storeId: store.id, userId: owner.id, role: "owner" } });
      const listing = await tx.listing.create({
        data: {
          storeId: store.id,
          customName: "Egusi",
          price: 1099,
          stockMode: "counted",
          qty: 40,
          frozen: false,
          perishable: false,
        },
      });
      await tx.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: 1099, weightG: 500 } });
    });
    await raw.appRateLimit.deleteMany({ where: { key: { startsWith: "assistant:" } } });
    origin = storeUrl(slug);
    storeSlug = slug;
    const revalidated = await fetch(`http://127.0.0.1:${process.env.E2E_PORT || "3200"}/api/storefront/revalidate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.STOREFRONT_REVALIDATION_SECRET ?? "e2e-storefront-revalidate"}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ stores: [{ id: store.id, slug }] }),
    });
    if (!revalidated.ok) throw new Error(`storefront revalidate returned ${revalidated.status}`);
  } finally {
    await raw.$disconnect();
  }
});

test.afterAll(async () => {
  const raw = db();
  try {
    if (sharedStripe) {
      const shared = await raw.store.findUnique({
        where: { slug: "mama-ngozi" },
        select: { stripeOnboardingStatus: true, stripeAccountId: true },
      });
      expect(shared?.stripeOnboardingStatus).toBe(sharedStripe.stripeOnboardingStatus);
      expect(shared?.stripeAccountId).toBe(sharedStripe.stripeAccountId);
    }
    const store = await raw.store.findUnique({ where: { slug: storeSlug }, select: { id: true } });
    if (!store || storeSlug === "mama-ngozi") return;
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      await tx.assistantCheckoutToken.deleteMany({ where: { storeId: store.id } });
      await tx.assistantCheckoutAttempt.deleteMany({ where: { storeId: store.id } });
      await tx.assistantCheckoutDraft.deleteMany({ where: { storeId: store.id } });
      await tx.assistantUndoReceipt.deleteMany({ where: { storeId: store.id } });
      await tx.aiAction.deleteMany({ where: { storeId: store.id } });
      await tx.aiConversation.deleteMany({ where: { storeId: store.id } });
      await tx.refundRequest.deleteMany({ where: { storeId: store.id } });
      await tx.guestBrowserCart.deleteMany({ where: { storeId: store.id } });
      await tx.orderLine.deleteMany({ where: { storeId: store.id } });
      await tx.order.deleteMany({ where: { storeId: store.id } });
      await tx.cartLine.deleteMany({ where: { storeId: store.id } });
      await tx.cart.deleteMany({ where: { storeId: store.id } });
      await tx.stockEvent.deleteMany({ where: { storeId: store.id } });
      await tx.customer.deleteMany({ where: { storeId: store.id } });
      await tx.auditLog.deleteMany({ where: { storeId: store.id } });
      await tx.listingVariant.deleteMany({ where: { listing: { storeId: store.id } } });
      await tx.listing.deleteMany({ where: { storeId: store.id } });
      await tx.storeMembership.deleteMany({ where: { storeId: store.id } });
    });
    await raw.store.delete({ where: { id: store.id } });
    const revalidated = await fetch(`http://127.0.0.1:${process.env.E2E_PORT || "3200"}/api/storefront/revalidate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.STOREFRONT_REVALIDATION_SECRET ?? "e2e-storefront-revalidate"}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ stores: [{ id: store.id, slug: storeSlug }] }),
    });
    if (!revalidated.ok) throw new Error(`storefront revalidate returned ${revalidated.status}`);
  } finally {
    await raw.$disconnect();
  }
});

async function say(page: Page, text: string) {
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await dialog.getByTestId("assistant-composer").fill(text);
  await dialog.getByTestId("assistant-send").click();
  return dialog;
}

async function drawPayableCard(page: Page) {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  for (let time = 0; time < 2; time += 1) {
    await say(page, "add two egusi");
    await expect(dialog.getByText("Here is what I found.", { exact: true })).toHaveCount(time + 1, { timeout: 20_000 });
  }
  await say(page, "checkout");
  const contact = dialog.getByRole("button", { name: "Save contact" });
  const place = dialog.getByTestId("assistant-place-order");
  await expect(contact.or(place)).toBeVisible({ timeout: 20_000 });
  if (await contact.isVisible()) {
    await dialog.getByLabel("Name").fill("Ada Okonkwo");
    await dialog.getByLabel("Email").fill("ada@example.com");
    await dialog.getByLabel("Phone").fill("2025550147");
    await contact.click();
    await expect(dialog.getByText("Contact saved")).toBeVisible({ timeout: 20_000 });
    await say(page, "checkout");
  }
  await expect(place).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(/cancel for \d+ minutes/i)).toBeVisible();
  return dialog;
}

async function storeOwnerOrders(page: Page) {
  await page.goto(`${storeUrl()}/store-admin/sign-in?store=${storeSlug}`);
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
  await page.click("button[type='submit']");
  await page.waitForURL(
    (url) => url.pathname.startsWith("/store-admin") && !url.pathname.includes("sign-in"),
    { timeout: 15_000 },
  );
  await page.goto(`${storeUrl()}/store-admin/orders?store=${storeSlug}`);
  await expect(page.locator("h1", { hasText: "Orders" })).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async () => {
  const raw = db();
  await raw.appRateLimit.deleteMany({ where: { key: { startsWith: "assistant:" } } });
  await raw.$disconnect();
});

test("a customer draws a card, taps to place, cancels, and the store cannot see it yet", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const dialog = await drawPayableCard(page);
  if (process.env.ASSISTANT_CHECKOUT_SHOTS === "1") {
    const card = dialog.getByTestId("assistant-checkout-card").last();
    await card.scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 1440, height: 900 });
    await card.screenshot({ path: "test-results/assistant-checkout-shots-1440-light.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await card.screenshot({ path: "test-results/assistant-checkout-shots-390-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await card.screenshot({ path: "test-results/assistant-checkout-shots-390-dark.png" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await card.screenshot({ path: "test-results/assistant-checkout-shots-1440-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
  }
  await dialog.getByTestId("assistant-place-order").click();
  const orderLink = dialog.getByRole("link", { name: /Order placed/ });
  await expect(orderLink).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId("assistant-cancel-order").click();
  await expect(dialog.getByText("Cancelled")).toBeVisible({ timeout: 20_000 });

  const store = await browser.newPage();
  await storeOwnerOrders(store);
  await expect(store.getByText("Ada Okonkwo")).toHaveCount(0);
  await store.close();
});

test("a changed basket replaces the card and needs a new tap", async ({ page }) => {
  test.setTimeout(120_000);
  const dialog = await drawPayableCard(page);
  await say(page, "add two egusi");
  await expect(dialog.getByText("Here is what I found.", { exact: true })).toHaveCount(3, { timeout: 20_000 });
  await dialog.getByTestId("assistant-place-order").click();
  await expect(dialog.getByText("The total changed. Review the new card.")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole("link", { name: /Order placed/ })).toHaveCount(0);
  await expect(dialog.getByTestId("assistant-place-order")).toBeVisible();
});

test("normal checkout is refused while an assistant attempt is live", async ({ page }) => {
  test.setTimeout(120_000);
  const dialog = await drawPayableCard(page);
  await page.route("**/api/assistant/checkout/confirm", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes('"phase":"complete"')) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  const reserved = page.waitForResponse((res) => res.url().includes("/api/assistant/checkout/confirm") && res.ok());
  await dialog.getByTestId("assistant-place-order").click();
  await reserved;
  await expect(dialog.getByRole("link", { name: /Order placed/ })).toHaveCount(0);
  await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: `${origin}/` }]);
  await page.goto(`${origin}/checkout`);
  await page.getByRole("button", { name: /Pickup/ }).click();
  await page.getByLabel("Full name").fill("Ada Okonkwo");
  await page.getByLabel("Phone number (required)").fill("2025550147");
  await page.getByLabel("Email (required)").fill("ada@example.com");
  await expect(page.getByText("Card entry is simulated")).toBeVisible({ timeout: 20_000 });
  const pay = page.getByRole("button", { name: /^Pay/ });
  await expect(async () => {
    await pay.click();
    await expect(page.getByText("A payment is already in progress for this basket.")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
});
