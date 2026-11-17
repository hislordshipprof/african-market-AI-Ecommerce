import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { addItemToCart } from "./checkout-helpers";
import { storeUrl } from "./urls";

const base = storeUrl("mama-ngozi");

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
    const addButton = page.getByRole("button", { name: `Add ${name} to cart` });
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
