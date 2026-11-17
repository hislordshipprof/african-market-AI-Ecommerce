import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import Stripe from "stripe";
import { resolveDirectUrl } from "../src/lib/env";
import { E2E_PORT } from "./urls";
import { insertShopperAccount } from "./account-fixture";
import { sandboxConnectedAccountId } from "../src/lib/stripe/test-sandbox-account";
import { cleanupSavedCard3dsRun } from "./saved-card-3ds-run";

// Real Stripe.js against the Stripe test mode, on a server started without the fake provider
// (E2E_REAL_STRIPE=1 marks that lane; see the #311 report for the command).
const real = process.env.E2E_REAL_STRIPE === "1" && Boolean(process.env.STRIPE_SECRET_KEY);

test("real Stripe.js: a 3DS card is saved after its challenge, then pays again from the saved card", async ({ page }) => {
  test.skip(!real, "E2E_REAL_STRIPE=1 and a Stripe test key are required");
  test.setTimeout(300_000);
  page.setDefaultTimeout(25_000);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
  const accountId = await sandboxConnectedAccountId(stripe);
  const origin = `http://localhost:${E2E_PORT}`;
  const email = `e2e-t311-3ds-${Date.now().toString(36)}@test.example`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  // stores.stripe_account_id is unique and the sandbox has one ready account (#160), so the test shares the store that owns it;
  // its listing and shopper are its own, and cleanup deletes only those (cleanupSavedCard3dsRun).
  const store = await prisma.store.findUniqueOrThrow({ where: { stripeAccountId: accountId } });
  const slug = `${store.slug}`;
  const name = `Three DS Yam ${Date.now().toString(36)}`;
  let listingId = "";
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      const listing = await tx.listing.create({
        data: { storeId: store.id, customName: name, price: 4000, stockMode: "unlimited", frozen: false, perishable: false },
      });
      listingId = listing.id;
      await tx.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: 4000, weightG: 200 } });
    });

    await insertShopperAccount({ email, password: "E2eTestPass-123!", name: "Ada Saver" });
    const signin = await page.request.post("/api/auth/sign-in/email", { data: { email, password: "E2eTestPass-123!" }, headers: { Origin: origin } });
    expect(signin.ok(), await signin.text()).toBe(true);

    // 1. A 3DS-required card with the save tick: the challenge completes, the order is placed, the card is saved.
    await openCheckout(page, slug, name);
    await page.getByRole("checkbox", { name: /Save this card for next time/ }).check();
    const card = page.frameLocator("iframe[src*='elements-inner-payment']").first();
    await card.getByLabel("Card number").fill("4000002500003155");
    await card.getByLabel("Expiration date").fill("1234");
    await card.getByLabel("Security code").fill("123");
    await card.getByLabel("ZIP code").fill("77017");
    await fillContact(page, email);
    await page.getByRole("button", { name: /^Place order/ }).click();
    await completeChallenge(page);
    await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 60_000 });
    await page.goto("/account");
    await expect(page.getByTestId("account-card-list").getByText(/visa ending in 3155/)).toBeVisible();

    // 2. The next checkout pre-selects the saved card and pays through the saved-card branch (challenge again if asked).
    await openCheckout(page, slug, name);
    await expect(page.getByRole("radio", { name: /visa ending in 3155/ })).toBeChecked();
    await fillContact(page, email);
    await page.getByRole("button", { name: /^Place order/ }).click();
    await completeChallenge(page);
    await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 60_000 });

    const orders = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return tx.order.findMany({ where: { storeId: store.id, customer: { email } }, select: { paymentIntentId: true } });
    });
    expect(orders).toHaveLength(2);
    for (const order of orders) {
      const id = order.paymentIntentId as string;
      const intent = await stripe.paymentIntents.retrieve(id);
      expect([intent.status, intent.on_behalf_of, intent.transfer_data?.destination]).toEqual(["requires_capture", accountId, accountId]);
      console.info(`[t311] 3DS e2e PaymentIntent ${id} ${intent.status}`);
    }
  } finally {
    try {
      await cleanupSavedCard3dsRun(prisma, { storeId: store.id, email, listingId }, {
        cancelHold: (id) => stripe.paymentIntents.cancel(id),
        deleteCustomer: (id) => stripe.customers.del(id),
      });
    } finally {
      await prisma.$disconnect();
    }
  }
});

async function openCheckout(page: Page, slug: string, name: string) {
  // The store page is cached for up to 60s, so a listing made just now can take that long to show.
  await expect(async () => {
    await page.goto(`/?store=${slug}`);
    await expect(page.getByRole("button", { name: `Add ${name} to cart` })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 90_000 });
  await page.getByRole("button", { name: `Add ${name} to cart` }).click();
  await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
  await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();
  await page.goto(`/checkout?store=${slug}`);
  await expect(page.getByRole("button", { name: /^Place order/ })).toBeEnabled({ timeout: 30_000 });
}

async function fillContact(page: Page, email: string) {
  await page.getByLabel("Full name").fill("Ada Saver");
  await page.getByLabel("Phone number (required)").fill("2025550100");
  await page.getByLabel("Email (required)").fill(email);
}

/** Waits for Stripe's test 3DS page (a frame on testmode-acs.stripe.com), clicks Complete, and waits for it to close. */
async function completeChallenge(page: Page) {
  const acsFrame = () => page.frames().find((frame) => frame.url().startsWith("https://testmode-acs.stripe.com/"));
  await expect.poll(acsFrame, { message: "3DS challenge frame", timeout: 60_000 }).toBeDefined();
  await expect(async () => {
    await acsFrame()?.getByRole("button", { name: "Complete" }).click({ timeout: 5_000 });
    expect(acsFrame(), "3DS challenge closed").toBeUndefined();
  }).toPass({ timeout: 60_000 });
}
