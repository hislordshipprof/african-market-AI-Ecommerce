import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { E2E_PORT } from "./urls";
import { insertShopperAccount } from "./account-fixture";

const apiBase = `http://localhost:${E2E_PORT}`;
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function createStore(prisma: PrismaClient, slug: string, extra: Record<string, unknown> = {}) {
  return prisma.store.create({
    data: {
      slug,
      name: "Address Lane",
      themePreset: "palm-and-shea",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      storeDeliveryEnabled: true,
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
      timezone: "America/Chicago",
      ...extra,
    },
  });
}

async function removeStore(prisma: PrismaClient, storeId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await tx.customer.deleteMany({ where: { storeId } });
    await tx.cartLine.deleteMany({ where: { storeId } });
    await tx.cart.deleteMany({ where: { storeId } });
    await tx.listingVariant.deleteMany({ where: { listing: { storeId } } });
    await tx.listing.deleteMany({ where: { storeId } });
    await tx.auditLog.deleteMany({ where: { storeId } });
  });
  await prisma.store.delete({ where: { id: storeId } });
}

async function signIn(page: Page, email: string) {
  await page.goto("/account/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.locator("[data-slot='card-title']")).toContainText("Check your email", { timeout: 10_000 });
  const tokenRes = await page.request.get(`${apiBase}/api/e2e/magic-link-token?email=${encodeURIComponent(email)}`);
  const { token } = await tokenRes.json();
  await page.goto(`/api/auth/magic-link/verify?token=${token}&callbackURL=/account`);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible({ timeout: 15_000 });
}

test("#763: the saved address fills checkout, a picker offers the others, and items that can't ship are named", async ({ page }) => {
  test.setTimeout(180_000);
  const slug = `addr-${Date.now().toString(36)}`;
  const garri = `Ship Garri ${slug}`;
  const goat = `Frozen Goat ${slug}`;
  const email = `e2e-${slug}@test.example`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await createStore(prisma, slug);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      for (const [name, shippable, frozen] of [[garri, true, false], [goat, false, true]] as const) {
        const listing = await tx.listing.create({
          data: { storeId: store.id, customName: name, price: 1500, stockMode: "unlimited", frozen, perishable: false, shippable },
        });
        await tx.listingVariant.create({ data: { listingId: listing.id, label: "Bag", price: 1500, weightG: 907 } });
      }
    });
    await insertShopperAccount({ email, password: "E2eTestPass-123!", name: "Ada Address" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.$transaction(async (tx: Tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.user_id', ${user.id}, true)`;
      await tx.customerAddress.create({
        data: { userId: user.id, label: "Home", line1: "8505 Fenton St", city: "Silver Spring", state: "MD", zip: "20910", notes: "Ring the side door", isDefault: true },
      });
      await tx.customerAddress.create({
        data: { userId: user.id, label: "Office", line1: "1600 Pennsylvania Ave NW", line2: "Suite 2", city: "Washington", state: "DC", zip: "20500" },
      });
    });

    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: apiBase }]);
    const count = page.getByTestId("storefront-header").getByTestId("cart-count");
    await expect(async () => {
      await page.goto(`/?store=${slug}`);
      await expect(page.getByRole("button", { name: `Add ${garri} to basket` })).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await signIn(page, email);
    await page.goto("/");
    for (const [i, name] of [garri, goat].entries()) {
      await page.getByRole("button", { name: `Add ${name} to basket` }).click();
      await expect(count).toHaveText(String(i + 1));
      await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();
    }
    const ship = page.getByRole("button", { name: /^Ship/ });
    await expect(async () => {
      await page.goto(`/checkout?store=${slug}`);
      await expect(ship).toBeVisible();
    }).toPass({ timeout: 20_000 });

    // AC1: store delivery opens with the default address and its delivery notes.
    await page.getByRole("button", { name: /^Store delivery/ }).click();
    await expect(page.getByLabel("Street address")).toHaveValue("8505 Fenton St");
    await expect(page.getByLabel("City")).toHaveValue("Silver Spring");
    await expect(page.getByLabel("State")).toHaveValue("MD");
    await expect(page.getByLabel("ZIP")).toHaveValue("20910");
    await expect(page.getByLabel("Order notes (optional)")).toHaveValue("Ring the side door");
    const picker = page.getByLabel("Saved address");
    await picker.selectOption({ label: "Office · 1600 Pennsylvania Ave NW, Washington" });
    await expect(page.getByLabel("Street address")).toHaveValue("1600 Pennsylvania Ave NW");
    await expect(page.getByLabel("Apartment, suite (optional)")).toHaveValue("Suite 2");
    await expect(page.getByLabel("ZIP")).toHaveValue("20500");
    await expect(page.getByLabel("Order notes (optional)")).toHaveValue("");
    await picker.selectOption({ label: "Home · 8505 Fenton St, Silver Spring" });
    await expect(page.getByLabel("Street address")).toHaveValue("8505 Fenton St");

    // AC2: Ship names the item that can't ship and offers the ways out, before any address check.
    await ship.click();
    await expect(page.getByLabel("Street address")).toHaveValue("8505 Fenton St");
    const cantShip = page.locator("[data-issue='shipping']");
    await expect(cantShip).toContainText(`${goat} can't ship`, { timeout: 15_000 });
    await expect(cantShip).not.toContainText(garri);
    await expect(cantShip.getByRole("button", { name: "Choose pickup" })).toBeVisible();
    await expect(cantShip.getByRole("button", { name: "Choose store delivery" })).toBeVisible();
    await expect(page.getByText("We can't deliver there")).toHaveCount(0);

    // The address is fine: placing the order still names the item, never "We can't deliver there".
    await page.getByRole("button", { name: "Confirm address" }).click();
    await expect(page.getByRole("status").filter({ hasText: "8505 FENTON ST" })).toBeVisible();
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByRole("button", { name: /Place order/ }).click();
    await expect(cantShip).toContainText(`${goat} can't ship`);
    await expect(page.getByText("We can't deliver there")).toHaveCount(0);
    await proof(page, "checkout-cant-ship");

    await cantShip.getByRole("button", { name: "Remove it" }).click();
    await expect(count).toHaveText("1");
    await expect(cantShip).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "USPS Ground Advantage" })).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await proof(page, "checkout-saved-address-ship");
  } finally {
    await removeStore(prisma, store.id);
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  }
});

test.describe("closed store header", () => {
  test.use({ timezoneId: "America/Chicago" });

  test("#763 AC3: the header never promises a pickup time while the store is closed; it says when it opens", async ({ page }) => {
    const slug = `closed-${Date.now().toString(36)}`;
    // Open only on the day after tomorrow, store time, so it is closed now and opens on a named day.
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const inTwoDays = new Date(Date.now() + 2 * 86_400_000);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "long" }).format(inTwoDays).toLowerCase();
    const hours = Object.fromEntries(days.map((day) => [day, day === weekday ? "9:00 AM - 5:00 PM" : "Closed"]));
    const short = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short" }).format(inTwoDays);
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    const store = await createStore(prisma, slug, { hours, prepTimeMinutes: 30 });
    try {
      await expect(async () => {
        await page.goto(`/?store=${slug}`);
        await expect(page.getByTestId("store-name")).toHaveText("Address Lane");
      }).toPass({ timeout: 20_000 });
      const chip = page.getByTestId("storefront-header").locator(".sf-window-chip");
      await expect(chip).toContainText(`Opens ${short} 9 AM`);
      await expect(chip).not.toContainText("30 min");
      await proof(page, "header-closed");
    } finally {
      await removeStore(prisma, store.id);
      await prisma.$disconnect();
    }
  });
});

async function proof(page: Page, name: string) {
  const dir = process.env.PROOF_DIR;
  if (!dir) return;
  const size = page.viewportSize();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `${dir}/${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: null });
  if (size) await page.setViewportSize(size);
}
