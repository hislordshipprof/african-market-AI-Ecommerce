import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { HANDOFF_PREP_MINUTES, handoffTimezone } from "./handoff-timezone";
import { storeUrl } from "./urls";

async function scoped<T>(prisma: PrismaClient, storeId: string, run: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return run(tx);
  });
}

async function createHandoffStore(prisma: PrismaClient) {
  const slug = `handoff-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Handoff Market",
      themePreset: "palm-and-shea",
      status: "active",
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      prepTimeMinutes: HANDOFF_PREP_MINUTES,
      timezone: handoffTimezone(new Date()),
      minimumOrderCents: 0,
    },
  });
  await scoped(prisma, store.id, async (tx) => {
    const listing = await tx.listing.create({
      data: { storeId: store.id, customName: "Handoff Egusi", price: 1200, stockMode: "unlimited", frozen: false, perishable: false },
    });
    await tx.listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price: 1200, weightG: 454 } });
  });
  return { slug, storeId: store.id, origin: storeUrl(slug) };
}

async function removeHandoffStore(prisma: PrismaClient, storeId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await tx.orderLine.deleteMany({ where: { storeId } });
    await tx.order.deleteMany({ where: { storeId } });
    await tx.customer.deleteMany({ where: { storeId } });
    await tx.cartLine.deleteMany({ where: { storeId } });
    await tx.cart.deleteMany({ where: { storeId } });
    await tx.listingVariant.deleteMany({ where: { listing: { storeId } } });
    await tx.listing.deleteMany({ where: { storeId } });
    await tx.auditLog.deleteMany({ where: { storeId } });
  });
  await prisma.store.delete({ where: { id: storeId } });
}

/** The built server's id for the checkout draft action, so a test can hold that one request. */
function draftActionId(): string {
  const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as {
    node: Record<string, { filename: string; exportedName: string }>;
  };
  const id = Object.keys(manifest.node).find((key) => manifest.node[key].exportedName === "assistantCheckoutDraftAction");
  if (!id) throw new Error("assistantCheckoutDraftAction is not in the build");
  return id;
}

/** Chats until the Review card shows, and returns the card and its pickup label. */
async function chatToReview(page: Page, origin: string) {
  await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: origin }]);
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const sheet = page.getByRole("dialog", { name: "Shop with AI" });
  await page.getByTestId("assistant-composer").fill("add two egusi");
  await page.getByTestId("assistant-send").click();
  await expect(sheet.getByText("Here is what I found.").last()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("assistant-composer")).toBeEnabled();
  await page.getByTestId("assistant-composer").fill("I'm ready to check out");
  await page.getByTestId("assistant-send").click();

  const review = sheet.getByRole("region", { name: "Review your order" });
  await expect(review).toBeVisible({ timeout: 20_000 });
  await expect(review).toContainText(/Pickup · \d{1,2}:\d{2} [AP]M [CM][SD]T/);
  const slotLabel = (await review.getByText(/^Pickup · /).textContent())!.replace("Pickup · ", "");
  return { review, slotLabel };
}

test("the assistant hands off to normal checkout with the pickup time pre-selected, and only Pay places the order (#247)", async ({ page }) => {
  test.setTimeout(120_000);
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const { slug, storeId, origin } = await createHandoffStore(prisma);
  try {
    const { review, slotLabel } = await chatToReview(page, origin);
    await expect(review).toContainText("2 × Handoff Egusi");
    await expect(review).toContainText("$24.00");
    expect(await scoped(prisma, storeId, (tx) => tx.order.count())).toBe(0);
    const cart = await scoped(prisma, storeId, (tx) => tx.cart.findFirst());
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
    const order = await scoped(prisma, storeId, (tx) => tx.order.findFirst());
    expect(order?.fulfillment).toBe("pickup");
    expect(order?.pickupSlot).toMatch(/Z$/);
  } finally {
    await removeHandoffStore(prisma, storeId);
    await prisma.$disconnect();
  }
});

test("a pickup time the shopper picks before the assistant's draft loads is kept (#247)", async ({ page }) => {
  test.setTimeout(120_000);
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const { storeId, origin } = await createHandoffStore(prisma);
  try {
    const { review } = await chatToReview(page, origin);
    // Hold the draft read until the shopper has chosen. A fulfilled response
    // arrives whole, so its requestfinished event always fires.
    const actionId = draftActionId();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let held = 0;
    await page.route(/\/checkout$/, async (route) => {
      if (route.request().method() !== "POST" || route.request().headers()["next-action"] !== actionId) return route.fallback();
      held += 1;
      const response = await route.fetch();
      await released;
      await route.fulfill({ response });
    });
    await review.getByRole("link", { name: "Review and pay" }).click();
    await expect(page).toHaveURL(/\/checkout$/);
    await expect.poll(() => held, { timeout: 15_000 }).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Schedule pickup" }).click();
    const pickupTime = page.getByLabel("Pickup time");
    const chosen = await pickupTime.locator("option").nth(1).getAttribute("value");
    await pickupTime.selectOption(chosen!);

    const draftRead = page.waitForEvent("requestfinished", (request) => request.headers()["next-action"] === actionId);
    release();
    await draftRead;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(pickupTime).toHaveValue(chosen!);
  } finally {
    await removeHandoffStore(prisma, storeId);
    await prisma.$disconnect();
  }
});
