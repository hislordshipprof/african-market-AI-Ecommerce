import { mkdirSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { laneSmokePort, reservePort, startSpawnedServer, type RunningServer } from "./spawned-server";

const SHOTS = process.env.PROOF_DIR ?? "screenshots";

async function shoot(page: Page, name: string, target = page.getByTestId("turnstile")) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [label, size] of [["1280", { width: 1280, height: 1000 }], ["390", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await target.scrollIntoViewIfNeeded();
    // The widget's iframe repaints a moment after a resize.
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/872-${name}-${label}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
}

/** The always-pass widget answers on its own (its iframe sits in a closed shadow root); a submit before that sends no token. */
async function widgetPassed(page: Page) {
  await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue("XXXX.DUMMY.TOKEN.XXXX", { timeout: 20_000 });
}

// A server with Cloudflare's always-pass test keys (#872 AC2); playwright.config.ts runs the shared one with none (AC3).
test.describe("Turnstile with the always-pass test keys (#872)", () => {
  test.describe.configure({ mode: "serial", retries: 0 });
  test.use({ reducedMotion: "reduce" });

  let running: RunningServer;
  let port = 0;
  const run = Date.now().toString(36);
  const digits = String(Date.now()).slice(-4);
  const root = () => `http://localhost:${port}`;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    port = await reservePort(laneSmokePort());
    running = await startSpawnedServer({
      command: `pnpm exec next start -p ${port}`,
      shell: true,
      cwd: process.cwd(),
      port,
      env: {
        ...process.env,
        CI: "true",
        VERCEL: "",
        VERCEL_ENV: "",
        E2E_STORE_OVERRIDE: "",
        E2E_FAKE_STRIPE: "1",
        STRIPE_SECRET_KEY: "",
        PLATFORM_ROOT_DOMAIN: "localhost",
        BETTER_AUTH_URL: `http://localhost:${port}`,
        BETTER_AUTH_TRUSTED_ORIGINS: `http://localhost:${port}`,
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
        TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      },
      healthUrl: `http://127.0.0.1:${port}/api/health`,
      healthOk: (status) => status === 200 || status === 503,
    });
  });

  test.afterAll(async () => {
    await running?.stop();
  });

  test.beforeEach(async ({ page }) => {
    // A fresh client address per test, so reruns stay under the per-IP limits.
    await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${(Number(digits) % 200) + test.info().workerIndex + 1}-${run}-${test.info().title.length}` });
  });

  test("the store application shows the widget and is taken, also on a retry after a refused submit", async ({ page }) => {
    await page.goto(`${root()}/sell`);
    await page.getByLabel("Store name").fill(`Turnstile Market ${run}`);
    await page.getByLabel("Kind of store").selectOption("african");
    await page.getByLabel("Street address").fill("2100 Bissonnet St");
    await page.getByLabel("City").fill("Houston");
    await page.getByLabel("State").selectOption("TX");
    await page.getByLabel("ZIP").fill("ABCDE");
    await page.getByLabel("Your name").fill("Ada Obi");
    await page.getByLabel("Email").fill(`turnstile-${run}@example.com`);
    await page.getByLabel("Phone").fill(`713555${digits}`);
    await page.getByRole("radio", { name: "Pro", exact: true }).check();
    await widgetPassed(page);
    await shoot(page, "sell");
    await page.getByRole("button", { name: "Send application" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Check the highlighted fields." })).toBeVisible();
    // The refused try spent its token; the remounted widget gets a fresh one.
    await page.getByLabel("ZIP").fill("77005");
    await widgetPassed(page);
    await page.getByRole("button", { name: "Send application" }).click();
    await expect(page.getByRole("heading", { name: "Thanks, we have your application" })).toBeVisible();
  });

  test("the store suggestion form shows the widget and is taken", async ({ page }) => {
    await page.goto(`${root()}/`);
    await page.getByLabel("ZIP code or city").fill("10001");
    await page.getByRole("button", { name: "Find stores" }).click();
    const panel = page.getByRole("region", { name: "Tell me when a store opens near me" });
    await panel.getByLabel("Email or mobile number").fill(`turnstile-${run}@example.com`);
    await panel.getByRole("checkbox").check();
    await widgetPassed(page);
    await shoot(page, "store-request");
    await panel.getByRole("button", { name: "Notify me" }).click();
    await expect(panel.getByRole("status")).toHaveText("Thanks. We'll send you one message when a store opens within 50 miles of 10001.");
  });

  test("shopper sign-in shows the widget and sends the link", async ({ page }) => {
    await page.goto(`http://mama-ngozi.localhost:${port}/account/sign-in`);
    await page.getByLabel("Email address").fill(`turnstile-${run}@test.example`);
    await widgetPassed(page);
    await shoot(page, "sign-in");
    await page.getByRole("button", { name: "Send sign-in link" }).click();
    await expect(page.getByText(`We sent a sign-in link to turnstile-${run}@test.example`)).toBeVisible();
  });

  test("checkout shows the widget beside Pay and places the order", async ({ page }) => {
    test.setTimeout(120_000);
    const slug = `turnstile-${run}`;
    const host = `http://${slug}.localhost:${port}`;
    const name = `Turnstile Yam ${run}`;
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    const store = await prisma.store.create({
      data: {
        slug, name: "Turnstile Lane", themePreset: "palm-and-shea", status: "active", stripeOnboardingStatus: "complete",
        stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`, pickupEnabled: true, minimumOrderCents: 0,
        addressLine1: "8400 Park Place Blvd", city: "Houston", state: "TX", zip: "77017", lat: 29.693857800118, lng: -95.266257879374,
      },
    });
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
        const listing = await tx.listing.create({ data: { storeId: store.id, customName: name, price: 4000, stockMode: "unlimited", frozen: false, perishable: false } });
        await tx.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: 4000, weightG: 200 } });
      });
      await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: host }]);
      const addButton = page.getByRole("button", { name: new RegExp(`^Add ${name} to`) });
      await expect(async () => {
        await page.goto(host);
        await expect(addButton).toBeVisible();
      }).toPass({ timeout: 30_000 });
      await addButton.click();
      await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
      await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden();
      await page.goto(`${host}/checkout`);
      await expect(page.getByRole("button", { name: /Place order/ })).toBeEnabled({ timeout: 20_000 });
      await page.getByLabel("Full name").fill("E2E Guest");
      await page.getByLabel("Phone number (required)").fill("2025550199");
      await page.getByLabel("Email (required)").fill("e2e@test.example");
      await widgetPassed(page);
      await shoot(page, "checkout");
      await page.getByRole("button", { name: /Place order/ }).click();
      await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 30_000 });
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
      }).catch(() => {});
      await prisma.store.delete({ where: { id: store.id } }).catch(() => {});
      await prisma.$disconnect();
    }
  });
});
