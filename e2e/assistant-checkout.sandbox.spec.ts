import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Locator, type Page } from "@playwright/test";
import Stripe from "stripe";
import { resolveDirectUrl } from "../src/lib/env";
import { laneSmokePort, reservePort, startSpawnedServer, type RunningServer } from "./spawned-server";

/**
 * Real Stripe test-mode evidence for the assistant sheet.
 * Not part of the default Playwright run. Start it with E2E_STRIPE_SANDBOX=1.
 * It fails, and does not skip, unless both keys are sk_test_ and pk_test_.
 */

const DECLINED = "4000000000000002";
const CHALLENGE = "4000000000003220";
const GOOD = "4242424242424242";

let prisma: PrismaClient;
let stripe: Stripe;
let server: RunningServer | undefined;
let storeId = "";
let origin = "";
const paymentIntents: string[] = [];

function databaseUrl(): string {
  return process.env.DATABASE_URL || resolveDirectUrl();
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const secret = process.env.STRIPE_SECRET_KEY ?? "";
  const publishable = process.env.STRIPE_PUBLISHABLE_KEY ?? "";
  if (!secret.startsWith("sk_test_") || !publishable.startsWith("pk_test_")) {
    throw new Error("Stripe test keys are required. Refusing to skip.");
  }
  prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  stripe = new Stripe(secret);
  let accountId = "";
  for await (const account of stripe.accounts.list({ limit: 100 })) {
    if (account.capabilities?.card_payments !== "active" || account.capabilities?.transfers !== "active") continue;
    const taken = await prisma.store.findUnique({ where: { stripeAccountId: account.id }, select: { id: true, slug: true } });
    if (taken && !taken.slug.startsWith("asst-sbx-")) continue;
    if (taken) await destroyStore(taken.id);
    accountId = account.id;
    break;
  }
  if (!accountId) throw new Error("No free connected account with active card_payments and transfers");

  const mama = await prisma.store.findUnique({
    where: { slug: "mama-ngozi" },
    select: { timezone: true, prepTimeMinutes: true, minimumOrderCents: true },
  });
  if (!mama) throw new Error("mama-ngozi is not seeded");
  const slug = `asst-sbx-${Date.now().toString(36)}`;
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Assistant Sandbox Market",
      themePreset: "palm-and-shea",
      status: "active",
      stripeOnboardingStatus: "complete",
      stripeAccountId: accountId,
      pickupEnabled: true,
      timezone: mama.timezone,
      prepTimeMinutes: mama.prepTimeMinutes,
      minimumOrderCents: mama.minimumOrderCents,
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
  storeId = store.id;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
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
    await tx.listingVariant.create({
      data: { listingId: listing.id, label: "Each", price: 1099, weightG: 500 },
    });
  });

  const port = await reservePort(laneSmokePort(process.env.E2E_PORT || "3200"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.E2E_FAKE_STRIPE;
  delete env.VERCEL;
  delete env.VERCEL_ENV;
  env.CI = "true";
  env.E2E_FAKE_ASSISTANT = "1";
  env.ASSISTANT_CHAT_ENABLED = "1";
  env.ANTHROPIC_API_KEY = "e2e-fake-anthropic-key";
  env.DATABASE_URL = databaseUrl();
  env.DIRECT_URL = process.env.DIRECT_URL || databaseUrl();
  env.STRIPE_SECRET_KEY = secret;
  env.STRIPE_PUBLISHABLE_KEY = publishable;
  server = await startSpawnedServer({
    command: `pnpm exec next start -p ${port}`,
    shell: true,
    cwd: process.cwd(),
    port,
    timeoutMs: 120_000,
    healthTimeoutMs: 60_000,
    env,
    healthUrl: `http://127.0.0.1:${port}/api/health`,
  });
  origin = `http://${slug}.localhost:${port}`;
  const revalidated = await fetch(`http://127.0.0.1:${port}/api/storefront/revalidate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.STOREFRONT_REVALIDATION_SECRET ?? "e2e-storefront-revalidate"}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ stores: [{ id: store.id, slug }] }),
  });
  if (!revalidated.ok) throw new Error(`storefront revalidate returned ${revalidated.status}`);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await server?.stop();
  if (stripe) {
    for (const id of paymentIntents) {
      try {
        const current = await stripe.paymentIntents.retrieve(id);
        if (current.status !== "canceled") await stripe.paymentIntents.cancel(id);
      } catch {
        // Already closed, or the test never created it.
      }
    }
  }
  if (prisma && storeId) await destroyStore(storeId);
  await prisma?.$disconnect();
});

async function destroyStore(id: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${id}, true)`;
    await tx.assistantCheckoutToken.deleteMany({ where: { storeId: id } });
    await tx.assistantCheckoutAttempt.deleteMany({ where: { storeId: id } });
    await tx.assistantCheckoutDraft.deleteMany({ where: { storeId: id } });
    await tx.assistantUndoReceipt.deleteMany({ where: { storeId: id } });
    await tx.aiAction.deleteMany({ where: { storeId: id } });
    await tx.aiConversation.deleteMany({ where: { storeId: id } });
    await tx.refundRequest.deleteMany({ where: { storeId: id } });
    await tx.guestBrowserCart.deleteMany({ where: { storeId: id } });
    await tx.orderLine.deleteMany({ where: { storeId: id } });
    await tx.order.deleteMany({ where: { storeId: id } });
    await tx.cartLine.deleteMany({ where: { storeId: id } });
    await tx.cart.deleteMany({ where: { storeId: id } });
    await tx.stockEvent.deleteMany({ where: { storeId: id } });
    await tx.customer.deleteMany({ where: { storeId: id } });
    await tx.auditLog.deleteMany({ where: { storeId: id } });
    await tx.listingVariant.deleteMany({ where: { listing: { storeId: id } } });
    await tx.listing.deleteMany({ where: { storeId: id } });
    await tx.storeMembership.deleteMany({ where: { storeId: id } });
  });
  await prisma.store.delete({ where: { id } }).catch(() => undefined);
}

test.beforeEach(async () => {
  await prisma.appRateLimit.deleteMany({ where: { key: { startsWith: "assistant:" } } });
});

function watchIntents(page: Page): string[] {
  const ids: string[] = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/api/assistant/checkout/confirm")) return;
    try {
      const body = await response.json() as { paymentIntentId?: unknown };
      if (typeof body.paymentIntentId === "string" && !ids.includes(body.paymentIntentId)) {
        ids.push(body.paymentIntentId);
        if (!paymentIntents.includes(body.paymentIntentId)) paymentIntents.push(body.paymentIntentId);
      }
    } catch {
      // A non-JSON response is not a PaymentIntent.
    }
  });
  return ids;
}

async function say(page: Page, text: string) {
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await dialog.getByTestId("assistant-composer").fill(text);
  await dialog.getByTestId("assistant-send").click();
  return dialog;
}

async function drawCard(page: Page) {
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
  await expect(page.locator('iframe[title="Secure payment input frame"]').first()).toBeVisible({ timeout: 30_000 });
  return dialog;
}

async function tapPlace(dialog: Locator) {
  const button = dialog.getByTestId("assistant-place-order");
  await expect(button).toBeEnabled();
  // After the card iframe is focused, the browser spends the next pointer click
  // blurring that frame, so the Place handler never runs. A DOM click still does.
  await button.evaluate((node) => {
    (node as HTMLButtonElement).click();
  });
}

async function fillCard(page: Page, number: string) {
  const numberSelector = "#Field-numberInput, input[name='number'], input[name='cardnumber'], input[autocomplete='cc-number'], input[aria-label='Card number']";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const card = frame.getByRole("button", { name: /^Card$/ });
      if (await card.count() && await card.first().isVisible().catch(() => false)) {
        await card.first().click().catch(() => undefined);
      }
      const numberField = frame.locator(numberSelector).first();
      if (!(await numberField.isVisible().catch(() => false))) continue;
      await numberField.fill(number);
      await frame.locator("#Field-expiryInput, input[name='expiry'], input[autocomplete='cc-exp']").first().fill("1234");
      await frame.locator("#Field-cvcInput, input[name='cvc'], input[autocomplete='cc-csc']").first().fill("123");
      const postal = frame.locator("#Field-postalCodeInput, input[name='postalCode'], input[autocomplete='postal-code']");
      if (await postal.count() && await postal.first().isVisible().catch(() => false)) {
        await postal.first().fill("77001");
      }
      return;
    }
    await page.waitForTimeout(250);
  }
  const files = page.frames().map((frame) => frame.url().split("/").pop()?.split(/[?#]/)[0] || "(blank)").slice(0, 12);
  throw new Error(`Payment Element card field was not visible. Frame files: ${files.join(" | ")}`);
}

async function orderRow(orderId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, paymentIntentId: true, cancellableUntil: true },
    });
  });
}

test.describe("assistant checkout against Stripe test mode", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test("a 4242 card places the order and the cancel window is set", async ({ page }) => {
    watchIntents(page);
    const dialog = await drawCard(page);
    await fillCard(page, GOOD);
    await tapPlace(dialog);
    const orderLink = dialog.getByRole("link", { name: /Order placed/ });
    await expect(orderLink).toBeVisible({ timeout: 40_000 });
    const orderId = (await orderLink.getAttribute("href"))?.split("/").pop() ?? "";
    const order = await orderRow(orderId);
    expect(order?.cancellableUntil).toBeTruthy();
    expect(order?.paymentIntentId).toBeTruthy();
  });

  test("cancel inside the window voids that PaymentIntent", async ({ page }) => {
    const ids = watchIntents(page);
    const dialog = await drawCard(page);
    await fillCard(page, GOOD);
    await tapPlace(dialog);
    const orderLink = dialog.getByRole("link", { name: /Order placed/ });
    await expect(orderLink).toBeVisible({ timeout: 40_000 });
    await dialog.getByTestId("assistant-cancel-order").evaluate((node) => {
      (node as HTMLButtonElement).click();
    });
    await expect(dialog.getByText("Cancelled")).toBeVisible({ timeout: 40_000 });
    const paymentIntentId = ids.at(-1);
    expect(paymentIntentId).toBeTruthy();
    const retrieved = await stripe.paymentIntents.retrieve(paymentIntentId!);
    expect(retrieved.status).toBe("canceled");
  });

  test("a declined card then a good card uses the same PaymentIntent and places once", async ({ page }) => {
    const ids = watchIntents(page);
    const dialog = await drawCard(page);
    await fillCard(page, DECLINED);
    await tapPlace(dialog);
    await expect(dialog.getByRole("status").filter({ hasText: /declined/i })).toBeVisible({ timeout: 40_000 });
    await expect(dialog.getByRole("link", { name: /Order placed/ })).toHaveCount(0);
    await expect.poll(() => ids.at(-1), { timeout: 15_000 }).toBeTruthy();
    const declined = ids.at(-1);
    await fillCard(page, GOOD);
    await tapPlace(dialog);
    const orderLink = dialog.getByRole("link", { name: /Order placed/ });
    await expect(orderLink).toBeVisible({ timeout: 40_000 });
    await expect.poll(() => ids.length > 0 && ids.every((id) => id === declined), { timeout: 15_000 }).toBe(true);
    const orderId = (await orderLink.getAttribute("href"))?.split("/").pop() ?? "";
    const order = await orderRow(orderId);
    expect(order?.paymentIntentId).toBe(declined);
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
      return tx.order.findMany({ where: { storeId, paymentIntentId: declined } });
    });
    expect(rows).toHaveLength(1);
  });

  test("a closed 3DS challenge releases that PaymentIntent and a new card places", async ({ page }) => {
    const ids = watchIntents(page);
    const dialog = await drawCard(page);
    await fillCard(page, CHALLENGE);
    await tapPlace(dialog);
    await closeChallenge(page);
    await expect(dialog.getByTestId("assistant-place-order")).toHaveText("Place order", { timeout: 40_000 });
    await expect.poll(() => ids.at(-1), { timeout: 15_000 }).toBeTruthy();
    const challenged = ids.at(-1);
    await tapPlace(dialog);
    await expect(dialog.getByText("The total changed. Review the new card.")).toBeVisible({ timeout: 40_000 });
    const released = await stripe.paymentIntents.retrieve(challenged!);
    expect(released.status).toBe("canceled");
    await expect(page.locator('iframe[title="Secure payment input frame"]').first()).toBeVisible({ timeout: 30_000 });
    await fillCard(page, GOOD);
    await tapPlace(dialog);
    const orderLink = dialog.getByRole("link", { name: /Order placed/ });
    await expect(orderLink).toBeVisible({ timeout: 40_000 });
    const orderId = (await orderLink.getAttribute("href"))?.split("/").pop() ?? "";
    const order = await orderRow(orderId);
    expect(order?.paymentIntentId).toBeTruthy();
    expect(order?.paymentIntentId).not.toBe(challenged);
  });
});

function challengeFrame(url: string): boolean {
  if (/hcaptcha/i.test(url)) return false;
  return /3d_secure|three-ds|authorize-with-url|m-outer-|\/inner\.html/i.test(url);
}

function frameFile(url: string): string {
  return url.split("/").pop()?.split(/[?#]/)[0] || "(blank)";
}

function challengeRelated(frame: { url: () => string; parentFrame: () => { url: () => string } | null }): boolean {
  if (challengeFrame(frame.url())) return true;
  const parent = frame.parentFrame();
  return parent != null && challengeFrame(parent.url());
}

async function challengeControls(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const frame of page.frames()) {
    if (!challengeRelated(frame)) continue;
    const names = await frame.getByRole("button").allInnerTexts().catch(() => [] as string[]);
    const text = await frame.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
    const visible = text.replace(/\s+/g, " ").trim().slice(0, 120);
    found.push(`${frameFile(frame.url())}[${names.map((name) => name.replace(/\s+/g, " ").trim()).join(",")}] ${visible}`);
  }
  return found;
}

async function closeChallenge(page: Page) {
  const place = page.getByRole("dialog", { name: "Shop with help" }).getByTestId("assistant-place-order");
  const openedAt = Date.now() + 30_000;
  let challenge = page.frames().find((frame) => /three-ds-2-challenge/i.test(frame.url()));
  while (!challenge && Date.now() < openedAt) {
    const popup = page.context().pages().find((other) => other !== page);
    if (popup) await popup.close();
    await page.waitForTimeout(250);
    challenge = page.frames().find((frame) => /three-ds-2-challenge/i.test(frame.url()));
  }
  const finishBy = Date.now() + 20_000;
  while (Date.now() < finishBy) {
    const frame = page.frames().find((item) => /three-ds-2-challenge/i.test(item.url()));
    const cancel = frame?.getByText(/^cancel$/i);
    if (cancel && await cancel.count()) await cancel.first().click({ timeout: 2_000 }).catch(() => undefined);
    const text = await place.innerText({ timeout: 1_000 }).catch(() => "");
    if (text.trim() === "Place order") return;
    await page.waitForTimeout(300);
  }
  const files = page.frames().map((frame) => frameFile(frame.url())).slice(0, 16);
  const controls = await challengeControls(page);
  throw new Error(`3DS challenge stayed open. Frame files: ${files.join(" | ")}. Controls: ${controls.join(" || ") || "(none)"}`);
}
