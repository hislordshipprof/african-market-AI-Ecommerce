import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";
import { generateTOTP } from "./totp";

const SLUG = "mama-ngozi";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";

function db() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the plan e2e");
  return new PrismaClient({ adapter: new PrismaPg(url) });
}

/** Sets the store's billing as a Stripe webhook would have left it. */
async function setBilling(row: { plan: string; status: string; paymentFailed: boolean; pilot?: boolean; chats?: number }) {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    const month = new Date(`${new Date().toISOString().slice(0, 7)}-01T00:00:00Z`);
    const subscribed = row.status !== "none";
    const fields = {
      plan: row.plan,
      status: row.status,
      pilot: row.pilot ?? false,
      paymentFailedAt: row.paymentFailed ? new Date() : null,
      stripeSubscriptionId: subscribed ? "sub_e2e_494" : null,
      stripeCustomerId: subscribed ? "cus_e2e_494" : null,
      currentPeriodEnd: subscribed ? new Date(Date.now() + 20 * 86_400_000) : null,
      overridePlan: null,
      overrideEndsAt: null,
      overrideReason: null,
    };
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.storeSubscription.upsert({
        where: { storeId: store.id },
        create: { storeId: store.id, ...fields },
        update: fields,
      }),
      prisma.assistantChatMonth.upsert({
        where: { storeId_month: { storeId: store.id, month } },
        create: { storeId: store.id, month, chats: row.chats ?? 0 },
        update: { chats: row.chats ?? 0 },
      }),
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

async function clearBilling() {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.storeSubscription.deleteMany({ where: { storeId: store.id } }),
      prisma.assistantChatMonth.deleteMany({ where: { storeId: store.id } }),
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

const APPLICATION_ID = "e2e-838-application";

/** The application this store was approved from, with the plan its applicant chose (#838). */
async function setApplicationChoice(planChoice: string | null) {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.storeApplication.deleteMany({ where: { id: APPLICATION_ID } });
      if (!planChoice) return;
      await tx.storeApplication.create({
        data: {
          id: APPLICATION_ID, businessName: "Mama Ngozi", storeType: "african", addressLine1: "1 Main St", city: "Houston",
          state: "TX", zip: "77002", ownerName: "Ngozi", email: "owner@mama-ngozi.test", phone: "+17135550838",
          planChoice, status: "approved", decidedAt: new Date(), storeId: store.id,
        },
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

const CHAT_ID = "e2e-818-chat";

/** A past chat the owner had while on Pro (#818), so a Starter store has history to read. */
async function seedPastChat() {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    const messages = [
      { role: "owner", text: "how were sales last week?" },
      { role: "assistant", text: "Nov 16 to Nov 22: 14 orders, $612.40 in goods sales and $548.10 net to store.", messageId: "e2e-818-m1" },
    ];
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      const owner = await tx.storeMembership.findFirstOrThrow({ where: { storeId: store.id, role: "owner", user: { email: "owner@mama-ngozi.test" } } });
      await tx.copilotConversation.deleteMany({ where: { id: CHAT_ID } });
      await tx.copilotConversation.create({ data: { id: CHAT_ID, storeId: store.id, userId: owner.userId, model: "e2e", messages, lastMessageAt: new Date() } });
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function clearPastChat() {
  const prisma = db();
  try {
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.copilotConversation.deleteMany({ where: { id: CHAT_ID } }),
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

async function adminSignIn(page: Page) {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Email").fill("admin@platform.test");
  await page.getByLabel("Password").fill(process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!");
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 10000 });
  await page.getByLabel("Verification code").fill(generateTOTP(process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP"));
  await page.click("button[type='submit']");
  await page.waitForURL("**/admin", { timeout: 15000 });
}

async function shoot(page: Page, name: string) {
  for (const [label, size] of [["1440px", { width: 1440, height: 1000 }], ["390px", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await page.screenshot({ path: `${SHOTS}/${name}-${label}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

test.describe.configure({ mode: "serial" });

test.describe("store subscriptions (#494)", () => {
  test.afterAll(async () => {
    await clearBilling();
    await clearPastChat();
  });

  test("Starter owner: plan page, failed-payment banner, 80% warning, Pro features locked with an upgrade link", async ({ page }) => {
    await setBilling({ plan: "starter", status: "past_due", paymentFailed: true, pilot: true, chats: 850 });
    await storeOwnerSignIn(page);

    await page.goto(`/store-admin?store=${SLUG}`);
    await expect(page.getByText("Your subscription payment failed.")).toBeVisible();
    await expect(page.getByText("850 of 1,000 chats this month")).toBeVisible();
    await expect(page.getByText("Analytics dashboard")).toBeVisible();
    await expect(page.getByRole("link", { name: "Upgrade to Pro" }).first()).toHaveAttribute("href", `/store-admin/plan?store=${SLUG}`);
    await shoot(page, "494-dashboard-starter");

    await page.goto(`/store-admin/plan?store=${SLUG}`);
    await expect(page.getByRole("heading", { name: "Starter plan" })).toBeVisible();
    await expect(page.getByText("Your last subscription payment failed.")).toBeVisible();
    await shoot(page, "494-plan-starter");

    // The chat is Pro (#818): past chats stay readable, the composer is the locked card.
    await seedPastChat();
    await page.goto(`/store-admin/copilot?store=${SLUG}`);
    await page.getByTestId("assistant-launcher").click();
    const sheet = page.getByRole("dialog", { name: "Store assistant" });
    await expect(sheet.getByText("how were sales last week?")).toBeVisible();
    await expect(sheet.getByText(/^Store assistant \(AI chat\)\s*Pro$/)).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Send" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Stock movement" })).toBeVisible();
    await shoot(page, "494-copilot-starter");

    await page.goto(`/store-admin/team?store=${SLUG}`);
    await expect(page.getByText(/staff seats used on the Starter plan/)).toBeVisible();
    await shoot(page, "494-team-starter");

    // The storefront stays up while the payment is failing.
    const store = await page.goto(`/?store=${SLUG}`);
    expect(store?.status()).toBe(200);
  });

  test("a pilot store with no subscription is offered 3 free months", async ({ page }) => {
    await setBilling({ plan: "starter", status: "none", paymentFailed: false, pilot: true });
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/plan?store=${SLUG}`);
    await expect(page.getByRole("button", { name: "Start Pro, 3 months free" })).toBeVisible();
    // One comparison, the same one /sell shows (#838); a feature that is not live says so (#809).
    const table = page.getByRole("table", { name: "Starter and Pro compared" });
    for (const label of ["Your own domain", "WhatsApp for copilot and alerts", "Analytics dashboard"]) {
      await expect(table.getByRole("rowheader", { name: `${label} (coming soon)` })).toBeVisible();
    }
    await expect(table.getByRole("row", { name: /Courier delivery/ })).toContainText("Not included on StarterIncluded on Pro");
    await expect(table.getByRole("row", { name: /Store assistant \(AI chat\)/ })).toContainText("Not included on StarterIncluded on Pro");
    await expect(page.getByRole("heading", { name: "Pro features" })).toHaveCount(0);
    await shoot(page, "494-plan-choose");
  });

  test("back from Checkout with a session id that cannot be confirmed: the plan stays and the waiting note shows (#841)", async ({ page }) => {
    await setBilling({ plan: "starter", status: "none", paymentFailed: false });
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/plan?store=${SLUG}&session_id=cs_test_not_this_store`);
    await expect(page.getByRole("heading", { name: "Starter plan" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Your plan shows here within a minute");
    await expect(page.getByRole("button", { name: "Choose Pro" })).toBeVisible();
    await shoot(page, "841-plan-return-unconfirmed");
  });

  test("the plan the applicant chose is preselected after approval (#838)", async ({ page }) => {
    await setBilling({ plan: "starter", status: "none", paymentFailed: false });
    await setApplicationChoice("starter");
    try {
      await storeOwnerSignIn(page);
      await page.goto(`/store-admin/plan?store=${SLUG}`);
      const starterCard = page.locator("form").filter({ has: page.getByRole("heading", { name: "Starter", exact: true }) });
      await expect(starterCard.getByText("You chose Starter when you applied.")).toBeVisible();
      await expect(page.getByText("when you applied")).toHaveCount(1);
      await shoot(page, "838-plan-preselected");
      await setApplicationChoice("undecided");
      await page.reload();
      await expect(page.getByText("when you applied")).toHaveCount(0);
    } finally {
      await setApplicationChoice(null);
    }
  });

  test("Pro owner: features included and nothing locked", async ({ page }) => {
    await setBilling({ plan: "pro", status: "active", paymentFailed: false });
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/plan?store=${SLUG}`);
    await expect(page.getByRole("heading", { name: "Pro plan" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Pro plan" }).getByText("Priority, same day", { exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Pro.*Your plan/ })).toBeVisible();
    await shoot(page, "494-plan-pro");
    await page.goto(`/store-admin?store=${SLUG}`);
    await expect(page.getByRole("link", { name: "Upgrade to Pro" })).toHaveCount(0);
    await page.goto(`/store-admin/copilot?store=${SLUG}`);
    await page.getByTestId("assistant-launcher").click();
    const sheet = page.getByRole("dialog", { name: "Store assistant" });
    await expect(sheet.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Send" })).toBeVisible();
  });

  test("admin console shows each store's plan and the failed payment, and sets the pilot offer", async ({ page }) => {
    await setBilling({ plan: "starter", status: "past_due", paymentFailed: true });
    await adminSignIn(page);
    await page.goto("/admin/stores");

    await expect(page.getByRole("alert").filter({ hasText: "Subscription payment failed" })).toBeVisible();
    await shoot(page, "494-admin-stores");

    await setBilling({ plan: "starter", status: "none", paymentFailed: false });
    await page.getByRole("row", { name: /Mama Ngozi/ }).getByRole("link", { name: "Edit" }).click();
    await page.getByRole("button", { name: "Make a pilot store (3 months free)" }).click();
    await expect(page.getByText("This store is a pilot store.")).toBeVisible();
    await shoot(page, "494-admin-store-pilot");
  });

  test("admin sets a Pro override; the overview, the plan gate and the owner's plan page follow it (#547)", async ({ page, browser }) => {
    await setBilling({ plan: "starter", status: "active", paymentFailed: false });
    await adminSignIn(page);

    await page.goto("/admin/billing/subscriptions?plan=pro");
    await expect(page.getByTestId(`subscription-${SLUG}`)).toHaveCount(0);
    await page.goto("/admin/billing/subscriptions?status=active");
    await page.getByTestId(`subscription-${SLUG}`).getByRole("link").click();
    await page.waitForURL(/\/admin\/stores\/[^/?]+$/);

    const endsOn = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel("Plan", { exact: true }).selectOption("pro");
    await page.getByLabel("Ends on (UTC)").fill(endsOn);
    await page.getByLabel("Reason").fill("Launch partner");
    await page.getByRole("button", { name: "Set override" }).click();
    await expect(page.getByText("Override saved.")).toBeVisible();
    await expect(page.getByTestId("override-state")).toContainText("Pro until");

    await page.goto("/admin/billing/subscriptions?plan=pro");
    const row = page.getByTestId(`subscription-${SLUG}`);
    await expect(row).toContainText("Pro");
    await expect(row).toContainText("Override until");
    await shoot(page, "547-admin-subscriptions");

    const owner = await browser.newPage();
    await storeOwnerSignIn(owner);
    await owner.goto(`/store-admin/plan?store=${SLUG}`);
    await expect(owner.getByRole("heading", { name: "Pro plan" })).toBeVisible();
    await expect(owner.getByTestId("plan-override")).toContainText("Pro, courtesy of the platform team until");
    await shoot(owner, "547-plan-override");
    await owner.close();
  });

  test("filters apply as soon as you choose them, with a count on each option (#837)", async ({ page }) => {
    await setBilling({ plan: "starter", status: "active", paymentFailed: false });
    await adminSignIn(page);

    await page.goto("/admin/billing/subscriptions");
    const status = page.getByLabel("Status", { exact: true });
    const plan = page.getByLabel("Plan", { exact: true });
    const row = page.getByTestId(`subscription-${SLUG}`);
    await expect(page.getByRole("button", { name: "Filter" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Clear filters" })).toHaveCount(0);
    await expect(status.locator("option", { hasText: /^Paused \(0\)$/ })).toHaveCount(1);
    await expect(page.getByText("Counts the plan in force; an override wins.")).toBeVisible();

    await plan.focus();
    await plan.selectOption("starter");
    await expect(page).toHaveURL(/[?&]plan=starter/);
    await expect(row).toBeVisible();
    await expect(plan).toBeFocused();
    await status.selectOption("active");
    await expect(page).toHaveURL(/[?&]status=active/);
    await expect(page).toHaveURL(/[?&]plan=starter/);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Active");
    await expect(plan.locator("option", { hasText: /^Pro \(\d+\)$/ })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Clear filters" })).toBeVisible();
    await shoot(page, "837-filters-on");

    await status.selectOption("paused");
    await expect(page).toHaveURL(/[?&]status=paused/);
    const empty = page.getByTestId("subscriptions-empty");
    await expect(empty).toContainText("No stores with status “Paused” on the Starter plan.");
    await expect(row).toHaveCount(0);
    await shoot(page, "837-filters-empty");

    await empty.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/admin\/billing\/subscriptions$/);
    await expect(status).toHaveValue("");
    await expect(plan).toHaveValue("");
    await expect(row).toBeVisible();
    await expect(page.getByRole("link", { name: "Clear filters" })).toHaveCount(0);
  });
});
