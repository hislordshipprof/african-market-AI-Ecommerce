import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";
import { storeOwnerSignIn } from "./store-owner-auth";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const STUCK_ID = "e2e-store-855-stuck";
const STUCK_NAME = "E2E Stuck Market 855";
const ACTIVE_ID = "e2e-store-855-active";
const ACTIVE_SLUG = "e2e-active-855";
const ACTIVE_NAME = "E2E Active Market 855";
const OWNER_EMAIL = "owner@mama-ngozi.test";
const STORE_SLUG = "mama-ngozi";
const LISTING = "E2E Plantain 855";
const PROOF = process.env.PROOF_DIR;

function prisma() {
  return new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
}

async function asPlatformAdmin<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const client = prisma();
  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return run(tx);
    });
  } finally {
    await client.$disconnect();
  }
}

async function asStore<T>(storeId: string, run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const client = prisma();
  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
      return run(tx);
    });
  } finally {
    await client.$disconnect();
  }
}

async function adminSignIn(page: Page) {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").waitFor({ state: "visible" });
  await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
  await page.click("button[type='submit']");
  await page.waitForURL("**/admin");
}

/** Viewport shots (the sheet is fixed) at phone and desktop width, in light and dark. */
async function proof(page: Page, name: string) {
  if (!PROOF) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const [width, height] of [[390, 844], [1280, 900]] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${PROOF}/855-${name}-${scheme}-${width}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function cleanAdmin() {
  await asPlatformAdmin(async (tx) => {
    const admin = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
    if (admin[0]) await tx.adminAssistantConversation.deleteMany({ where: { userId: admin[0].id } });
    await tx.auditLog.deleteMany({ where: { storeId: { in: [STUCK_ID, ACTIVE_ID] } } });
    await tx.store.deleteMany({ where: { id: { in: [STUCK_ID, ACTIVE_ID] } } });
  });
}

test.describe.configure({ mode: "serial" });

test.describe("platform admin assistant sheet (#855)", () => {
  test.beforeAll(async () => {
    await cleanAdmin();
    await asPlatformAdmin((tx) => tx.$executeRaw`INSERT INTO stores (id, name, slug, status, address_line1, zip, created_at, updated_at) VALUES
      (${STUCK_ID}, ${STUCK_NAME}, 'e2e-stuck-855', 'setup', '1 Setup Way', '77002', now() - interval '5 days', now()),
      (${ACTIVE_ID}, ${ACTIVE_NAME}, ${ACTIVE_SLUG}, 'active', '2 Live Way', '77002', now(), now())`);
  });
  test.afterAll(cleanAdmin);

  test("opens from the floating button on every page, keeps the thread across pages, and confirms a card inside the sheet", async ({ page }) => {
    await adminSignIn(page);
    await expect(page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Assistant", exact: true })).toHaveCount(0);
    const launcher = page.getByTestId("assistant-launcher");
    await expect(launcher).toBeVisible();
    await proof(page, "admin-closed");

    await launcher.click();
    const sheet = page.getByRole("dialog", { name: "Assistant" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("region", { name: "Today" }).getByText(STUCK_NAME, { exact: false })).toBeVisible();
    await expect(sheet.getByRole("group", { name: "Try asking" }).getByRole("button")).toHaveCount(4);
    await proof(page, "admin-empty");

    expect(Math.round((await sheet.boundingBox())!.width)).toBe(440);
    await sheet.getByRole("button", { name: "Widen the panel" }).click();
    expect((await sheet.boundingBox())!.width).toBeGreaterThan(800);
    await sheet.getByRole("button", { name: "Narrow the panel" }).click();

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(launcher).toBeFocused();

    // Shift+Enter adds a line; Enter sends.
    await launcher.click();
    const box = sheet.getByLabel("Message");
    await box.fill("Which stores are");
    await box.press("Shift+Enter");
    await box.pressSequentially("stuck in onboarding?");
    await expect(box).toHaveValue("Which stores are\nstuck in onboarding?");
    await box.press("Enter");
    const conversation = sheet.getByRole("region", { name: "Conversation" });
    await expect(conversation.getByText("These stores are still in setup.", { exact: false })).toBeVisible();
    await expect(box).toHaveValue("");
    await proof(page, "admin-thread");

    // A link in a reply opens the page behind; the sheet, the thread and the draft stay.
    await box.fill("half-typed question");
    await conversation.getByRole("link", { name: STUCK_NAME }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/stores/${STUCK_ID}$`));
    await expect(sheet).toBeVisible();
    await expect(conversation.getByText("These stores are still in setup.", { exact: false })).toBeVisible();
    await expect(box).toHaveValue("half-typed question");

    await sheet.getByRole("button", { name: "Close Assistant" }).click();
    await expect(sheet).toBeHidden();
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Refunds" }).click();
    await expect(page).toHaveURL(/\/admin\/orders$/);
    await launcher.click();
    await expect(conversation.getByText("These stores are still in setup.", { exact: false })).toBeVisible();
    await expect(box).toHaveValue("half-typed question");

    // Confirm cards keep their rules inside the sheet.
    await box.fill(`Suspend the store ${ACTIVE_SLUG}`);
    await sheet.getByRole("button", { name: "Send" }).click();
    const card = sheet.getByRole("article", { name: "Suspend store" });
    await expect(card.getByText("Nothing changes until you confirm.", { exact: false })).toBeVisible();
    await proof(page, "admin-card");
    await card.getByRole("button", { name: "Confirm" }).click();
    await expect(card.getByText("Done.")).toBeVisible();
    const status = await asPlatformAdmin((tx) => tx.store.findUniqueOrThrow({ where: { id: ACTIVE_ID }, select: { status: true } }));
    expect(status.status).toBe("suspended");

    // The overflow menu holds the activity page; Esc closes the menu before the sheet.
    await sheet.getByRole("button", { name: "More" }).click();
    await expect(sheet.getByRole("link", { name: "Assistant activity" })).toHaveAttribute("href", "/admin/assistant/activity");
    await page.keyboard.press("Escape");
    await expect(sheet.getByRole("link", { name: "Assistant activity" })).toHaveCount(0);
    await expect(sheet).toBeVisible();

    // A phone gets the full-height sheet.
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = (await sheet.boundingBox())!;
    expect([Math.round(phone.width), Math.round(phone.height)]).toEqual([390, 844]);
    await expect(sheet.getByRole("button", { name: "Widen the panel" })).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 900 });

    // The old page lands on Home with the sheet open.
    await page.goto("/admin/assistant");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(sheet).toBeVisible();
    await expect(conversation.getByText("These stores are still in setup.", { exact: false })).toBeVisible();

    // Hidden until the next full load, as on the storefront.
    await sheet.getByRole("button", { name: "More" }).click();
    await sheet.getByRole("button", { name: "Hide the button until I reload" }).click();
    await expect(sheet).toBeHidden();
    await expect(launcher).toHaveCount(0);
    await page.reload();
    await expect(launcher).toBeVisible();
  });

  test("a chat that failed to load loads when the sheet opens again", async ({ page }) => {
    await adminSignIn(page);
    let failing = true;
    let failed = 0;
    await page.route("**/admin", async (route) => {
      if (!failing || route.request().method() !== "POST" || !route.request().headers()["next-action"]) return route.fallback();
      failed += 1;
      await route.abort();
    });
    const launcher = page.getByTestId("assistant-launcher");
    const sheet = page.getByRole("dialog", { name: "Assistant" });
    await launcher.click();
    await expect(sheet.getByText("The assistant couldn't load.", { exact: false })).toBeVisible();
    // It tries again on the next open, not over and over while the sheet stays open.
    await page.waitForTimeout(1000);
    expect(failed).toBe(1);
    failing = false;

    await sheet.getByRole("button", { name: "Close Assistant" }).click();
    await expect(sheet).toBeHidden();
    await launcher.click();
    await expect(sheet.getByText("The assistant couldn't load.", { exact: false })).toHaveCount(0);
    await sheet.getByLabel("Message").fill("Which stores are stuck in onboarding?");
    await expect(sheet.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});

test.describe("store assistant sheet (#855)", () => {
  let storeId = "";
  let ownerId = "";

  async function clean() {
    await asStore(storeId, async (tx) => {
      await tx.copilotConversation.deleteMany({ where: { userId: ownerId } });
      const listings = await tx.listing.findMany({ where: { customName: LISTING }, select: { id: true } });
      await tx.copilotAlert.deleteMany({ where: { listingId: { in: listings.map((listing) => listing.id) } } });
      await tx.listing.deleteMany({ where: { customName: LISTING } });
      await tx.storeCoupon.deleteMany({ where: { code: "DOCK855" } });
    });
  }

  test.beforeAll(async () => {
    const client = prisma();
    try {
      storeId = (await client.store.findUniqueOrThrow({ where: { slug: STORE_SLUG } })).id;
      ownerId = (await client.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } })).id;
    } finally {
      await client.$disconnect();
    }
    await asPlatformAdmin((tx) => tx.storeSubscription.upsert({
      where: { storeId },
      create: { storeId, plan: "pro", status: "active" },
      update: { plan: "pro", status: "active", overridePlan: null, overrideEndsAt: null },
    }));
    await clean();
    await asStore(storeId, async (tx) => {
      const listing = await tx.listing.create({ data: { storeId, customName: LISTING, price: 400, stockMode: "counted", qty: 2, confidence: 1 } });
      await tx.copilotAlert.create({ data: { storeId, kind: "running_low", listingId: listing.id, dedupeKey: `e2e-855-${listing.id}` } });
    });
  });
  test.afterAll(() => clean());

  test("opens on any store-admin page with the alerts, sends, and confirms a drafted coupon in the sheet", async ({ page }) => {
    await storeOwnerSignIn(page);
    const launcher = page.getByTestId("assistant-launcher");
    // Sign-in moves on without a full load; the button still appears.
    await expect(launcher).toBeVisible();
    await page.goto(`/store-admin/orders?store=${STORE_SLUG}`);
    await expect(launcher).toBeVisible();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.mouse.wheel(0, 20_000);
    await page.waitForTimeout(400);
    if (PROOF) await page.screenshot({ path: `${PROOF}/855-store-page-bottom-dark-1280.png` });
    await page.emulateMedia({ colorScheme: "light" });
    await proof(page, "store-closed");

    await launcher.click();
    const sheet = page.getByRole("dialog", { name: "Store assistant" });
    await expect(sheet.getByRole("region", { name: "Stock alerts" }).getByText(`${LISTING} is running low`, { exact: false })).toBeVisible();
    await expect(sheet.getByRole("group", { name: "Try asking" }).getByRole("button")).toHaveCount(4);
    await proof(page, "store-empty");

    const box = sheet.getByLabel("Message");
    await box.fill("hello there");
    await box.press("Enter");
    const conversation = sheet.getByRole("region", { name: "Conversation" });
    await expect(conversation.getByText("hello there")).toBeVisible();
    await expect(conversation.getByText("Here is what I found.")).toBeVisible();
    await proof(page, "store-thread");

    // A coupon the chat drafted waits on a card in the sheet, as on the old page (#819).
    await asStore(storeId, async (tx) => {
      const conversationRow = await tx.copilotConversation.findFirstOrThrow({ where: { userId: ownerId } });
      await tx.copilotDraft.create({
        data: {
          storeId, conversationId: conversationRow.id, clientMessageId: crypto.randomUUID(), kind: "coupon", state: "pending",
          expiresAt: new Date(Date.now() + 24 * 3_600_000), before: {},
          payload: {
            code: "DOCK855", kind: "percent", percentOff: "10", amountOff: "", minGoods: "30.00",
            startsAt: "2099-11-28T00:00", endsAt: "2099-11-29T23:59", totalUses: "", usesPerCustomer: "", firstOrderOnly: "",
          },
        },
      });
    });
    await page.goto(`/store-admin/copilot?store=${STORE_SLUG}`);
    // The copilot page keeps alerts and reports, without its chat.
    await expect(page.getByRole("heading", { name: "Stock alerts" })).toBeVisible();
    await expect(page.locator("#copilot-report")).toHaveCount(0);
    await launcher.click();
    const waiting = sheet.getByLabel("Drafts waiting for you");
    await expect(waiting.getByText(/DOCK855: 10% off orders of \$30\.00 or more/)).toBeVisible();
    await proof(page, "store-card");
    await waiting.getByRole("button", { name: "Create coupon" }).click();
    await expect(sheet.getByText(/^DOCK855: 10% off/)).toBeVisible();
    const coupons = await asStore(storeId, (tx) => tx.storeCoupon.count({ where: { code: "DOCK855" } }));
    expect(coupons).toBe(1);
  });
});
