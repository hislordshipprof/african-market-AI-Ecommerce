import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";
import { generateTOTP } from "./totp";

const SLUG = "mama-ngozi";
const SHOTS = "screenshots";

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

async function shoot(page: Page, name: string) {
  for (const [label, size] of [["1440px", { width: 1440, height: 1000 }], ["390px", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await page.screenshot({ path: `${SHOTS}/${name}-${label}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

test.describe.configure({ mode: "serial" });

test.describe("store subscriptions (#494)", () => {
  test.afterAll(clearBilling);

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

    await page.goto(`/store-admin/copilot?store=${SLUG}`);
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
    await shoot(page, "494-plan-choose");
  });

  test("Pro owner: features included and nothing locked", async ({ page }) => {
    await setBilling({ plan: "pro", status: "active", paymentFailed: false });
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/plan?store=${SLUG}`);
    await expect(page.getByRole("heading", { name: "Pro plan" })).toBeVisible();
    await expect(page.getByText("Priority, same day", { exact: true })).toBeVisible();
    await shoot(page, "494-plan-pro");
    await page.goto(`/store-admin?store=${SLUG}`);
    await expect(page.getByRole("link", { name: "Upgrade to Pro" })).toHaveCount(0);
  });

  test("admin console shows each store's plan and the failed payment, and sets the pilot offer", async ({ page }) => {
    await setBilling({ plan: "starter", status: "past_due", paymentFailed: true });
    await page.goto("/admin/sign-in");
    await page.getByLabel("Email").fill("admin@platform.test");
    await page.getByLabel("Password").fill(process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!");
    await page.click("button[type='submit']");
    await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 10000 });
    await page.getByLabel("Verification code").fill(generateTOTP(process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP"));
    await page.click("button[type='submit']");
    await page.waitForURL("**/admin/stores", { timeout: 15000 });

    await expect(page.getByRole("alert").filter({ hasText: "Subscription payment failed" })).toBeVisible();
    await shoot(page, "494-admin-stores");

    await setBilling({ plan: "starter", status: "none", paymentFailed: false });
    await page.getByRole("row", { name: /Mama Ngozi/ }).getByRole("link", { name: "Edit" }).click();
    await page.getByRole("button", { name: "Make a pilot store (3 months free)" }).click();
    await expect(page.getByText("This store is a pilot store.")).toBeVisible();
    await shoot(page, "494-admin-store-pilot");
  });
});
