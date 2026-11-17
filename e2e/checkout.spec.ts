import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { addItemToCart } from "./checkout-helpers";
import { storeUrl } from "./urls";

const base = storeUrl("mama-ngozi");

async function fillContact(page: import("@playwright/test").Page) {
  await page.getByLabel("Full name").fill("E2E Guest");
  await page.getByLabel("Phone number (required)").fill("2025550199");
  await page.getByLabel("Email (required)").fill("e2e@test.example");
}

test.describe("Guest checkout flow", () => {
  test.describe.configure({ retries: 0 });
  test.use({ reducedMotion: "reduce" });

  test("nine plain quick-add clicks reach ten", async ({ page }) => {
    await addItemToCart(page);
  });

  test("checkout page shows guest contact form with required fields", async ({
    page,
  }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    await expect(
      page.getByRole("heading", { name: "Contact details" }),
    ).toBeVisible();
    await expect(page.getByLabel("Full name")).toBeVisible();
    await expect(page.getByLabel("Phone number (required)")).toBeVisible();
    await expect(page.getByLabel("Email (required)")).toBeVisible();
  });

  test("checkout shows buffer disclosure text", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    await expect(
      page.getByText("10% buffer, capped at $20"),
    ).toBeVisible();
  });

  test("checkout validates required contact fields before payment", async ({
    page,
  }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    await page.getByRole("button", { name: /Place demo order|Place order/ }).click();

    await expect(
      page.getByText("Enter the name for your order"),
    ).toBeVisible();
    // The first invalid field takes focus, so a keyboard shopper lands where to fix it.
    await expect(page.getByLabel("Full name")).toBeFocused();
    await page.getByLabel("Full name").fill("E2E Guest");
    await page.getByRole("button", { name: /Place demo order|Place order/ }).click();
    await expect(page.getByLabel("Phone number (required)")).toBeFocused();
    await expect(page.getByLabel("Full name")).toHaveValue("E2E Guest");
  });

  test("a declined payment shows beside the card with Use another card, and keeps the form (#717)", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);
    await fillContact(page);
    await page.getByLabel("Demo outcome").selectOption("declined");
    await page.getByRole("button", { name: /Place demo order/ }).click();

    const alert = page.locator("#payment").getByRole("alert");
    await expect(alert).toContainText("Test payment declined");
    await expect(alert).toBeFocused();
    await expect(page.locator("#review").getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("Email (required)")).toHaveValue("e2e@test.example");
    await alert.getByRole("button", { name: "Use another card" }).click();
    await expect(alert).toBeHidden();
    await expect(page.getByLabel("Demo outcome")).toBeFocused();
  });

  test("an unavailable item highlights its line with Review basket (#717)", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);
    await fillContact(page);
    await page.getByLabel("Demo outcome").selectOption("out-of-stock");
    await page.getByRole("button", { name: /Place demo order/ }).click();

    const review = page.locator("#review");
    const alert = review.getByRole("alert");
    await expect(alert).toContainText("An item is unavailable.");
    await expect(review.locator("li[data-problem]")).toHaveCount(1);
    await expect(review.locator("li[data-problem]")).toContainText("Yellow Garri");
    await expect(alert.getByRole("link", { name: "Review basket" })).toHaveAttribute("href", "/cart");
    await expect(page.locator("#payment").getByRole("alert")).toHaveCount(0);
  });

  test("an expired session offers Refresh checkout and keeps the form (#717)", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);
    await fillContact(page);
    await page.getByLabel("Demo outcome").selectOption("session-expired");
    await page.getByRole("button", { name: /Place demo order/ }).click();

    const alert = page.locator("#review").getByRole("alert");
    await expect(alert).toContainText("Checkout session expired");
    await alert.getByRole("button", { name: "Refresh checkout" }).click();
    await expect(alert).toBeHidden();
    await expect(page.getByRole("button", { name: /Place demo order/ })).toBeEnabled();
    await expect(page.getByLabel("Full name")).toHaveValue("E2E Guest");
  });

  test("checkout tells a failed basket load from an empty basket (#708)", async ({ page }) => {
    await page.context().addCookies([{ name: "e2e_fail_cart_read", value: "1", url: base }]);
    await page.goto(`${base}/checkout`);
    await expect(page.getByRole("heading", { name: "We couldn\u2019t load your basket" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your basket is empty" })).toHaveCount(0);
    await page.context().clearCookies({ name: "e2e_fail_cart_read" });
    await page.getByRole("main").getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: "Your basket is empty" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Browse aisles" })).toBeVisible();
  });

  test("fulfillment options are visible", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    await expect(
      page.getByRole("button", { name: /Pickup.*Free/ }),
    ).toBeVisible();
  });

  test("order summary shows line items and totals", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    const review = page.locator("#review");
    await expect(
      review.getByRole("heading", { name: "Your order", exact: true }),
    ).toBeVisible();
    await expect(review.getByText("Subtotal")).toBeVisible();
    await expect(review.getByText("Temporary swap buffer")).toBeVisible();
    await expect(
      review.getByText("Authorization hold", { exact: true }),
    ).toBeVisible();
  });

  test("demo checkout places order successfully", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/cart`);
    await page
      .getByRole("link", { name: /^Checkout/ })
      .first()
      .click();

    await page.getByRole("button", { name: /Pickup.*Free/ }).click();
    await page.getByLabel("Full name").fill("E2E Guest");
    await page.getByLabel("Phone number (required)").fill("2025550199");
    await page.getByLabel("Email (required)").fill("e2e@test.example");
    await page.getByRole("button", { name: /Place demo order/ }).click();

    await expect(page).toHaveURL(/\/order\/[a-f0-9-]{36}\?placed=1/, {
      timeout: 15000,
    });
    await expect(
      page.getByRole("heading", { name: "Order placed", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("storefront-header").getByTestId("cart-count"),
    ).toHaveText("0");
  });

  test("promo code WELCOME10 is accepted", async ({ page }) => {
    await addItemToCart(page);
    await page.goto(`${base}/checkout`);

    await page.getByPlaceholder("Try WELCOME10").fill("WELCOME10");
    await page
      .getByRole("button", { name: "Apply" })
      .click();
    await expect(page.getByText("10% off applied")).toBeVisible();
  });
});

test("a real card decline shows beside the payment, not in the summary (#717)", async ({ page }) => {
  test.setTimeout(90_000);
  const slug = `decline-${Date.now().toString(36)}`;
  const name = `Decline Yam ${slug}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Decline Lane",
      themePreset: "palm-and-shea",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      minimumOrderCents: 0,
      addressLine1: "8400 Park Place Blvd",
      city: "Houston",
      state: "TX",
      zip: "77017",
      lat: 29.693857800118,
      lng: -95.266257879374,
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
    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: `http://localhost:${process.env.E2E_PORT || "3000"}` }]);
    // The fake's own declining card: the harness sends no card, so the test names it.
    await page.route("**/api/e2e/fake-confirm", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      await route.continue({ postData: JSON.stringify({ ...body, paymentMethodId: "pm_card_chargeCustomerFail" }) });
    });
    const addButton = page.getByRole("button", { name: new RegExp(`^Add ${name} to`) });
    await expect(async () => {
      await page.goto(`/?store=${slug}`);
      await expect(addButton).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await addButton.click();
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
    await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();
    await expect(async () => {
      await page.goto(`/checkout?store=${slug}`);
      await expect(page.getByRole("button", { name: /Place order/ })).toBeEnabled();
    }).toPass({ timeout: 20_000 });
    await fillContact(page);
    await page.getByRole("button", { name: /Place order/ }).click();
    const alert = page.locator("#payment").getByRole("alert");
    await expect(alert).toContainText("Your card was declined.", { timeout: 20_000 });
    await expect(alert.getByRole("button", { name: "Use another card" })).toBeVisible();
    await expect(page.locator("#review").getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("Full name")).toHaveValue("E2E Guest");
    await expect(page.getByRole("button", { name: /Place order/ })).toBeEnabled();
  } finally {
    await page.unroute("**/api/e2e/fake-confirm");
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

test("a hung address check settles to a failure and frees the button (#708)", async ({ page }) => {
  test.setTimeout(90_000);
  const slug = `hang-${Date.now().toString(36)}`;
  const name = `Hang Yam ${slug}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Hang Lane",
      themePreset: "palm-and-shea",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      storeDeliveryEnabled: true,
      storeDeliveryFeeCents: 500,
      deliveryRadiusMi: 8,
      minimumOrderCents: 0,
      addressLine1: "8400 Park Place Blvd",
      city: "Houston",
      state: "TX",
      zip: "77017",
      lat: 29.693857800118,
      lng: -95.266257879374,
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
    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: `http://localhost:${process.env.E2E_PORT || "3000"}` }]);
    const addButton = page.getByRole("button", { name: `Add ${name} to basket` });
    await expect(async () => {
      await page.goto(`/?store=${slug}`);
      await expect(addButton).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await addButton.click();
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
    await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();
    await expect(async () => {
      await page.goto(`/checkout?store=${slug}`);
      await expect(page.getByRole("button", { name: /Store delivery/ })).toBeVisible();
    }).toPass({ timeout: 20_000 });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.headers()["next-action"] && (request.postData() ?? "").includes("leaveAtDoor")) {
        held = true;
        return; // never answered: the address check hangs
      }
      await route.continue();
    });
    await page.getByRole("button", { name: /Store delivery/ }).click();
    await page.getByLabel("Street address").fill("3700 Main St");
    await page.getByLabel("City").fill("Houston");
    await page.getByLabel("State").fill("TX");
    await page.getByLabel("ZIP").fill("77002");
    await page.getByRole("button", { name: "Confirm address" }).click();
    await expect.poll(() => held).toBe(true);
    await expect(page.getByText("We couldn't check that address. Try again.")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole("button", { name: "Confirm address" })).toBeEnabled();
  } finally {
    await page.unroute("**/*");
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
