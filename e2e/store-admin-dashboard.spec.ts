import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { storeOwnerSignIn } from "./store-owner-auth";
import { generateTOTP } from "./totp";
import { E2E_PORT } from "./urls";

const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const EVERY_DAY = "12:00 AM - 11:59 PM";
const HOURS = Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [d, EVERY_DAY]));

function db() {
  return new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
}

async function asPlatformAdmin<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const prisma = db();
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return run(tx);
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [scheme, width] of [["light", 1280], ["dark", 390]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${SHOTS}/784-${name}-${width}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

// One new store in setup, ready to go live: mama-ngozi's owner owns it, and a staff member joins by invite.
test.describe.serial("Store admin dashboard (#784)", () => {
  const slug = `e2e-784-${Date.now().toString(36)}`;
  const staffEmail = `e2e-784-staff-${Date.now()}@test.example`;
  let storeId = "";
  let yamId = "";
  const inviteToken = randomBytes(32).toString("base64url");

  test.beforeAll(async () => {
    const floor = await asPlatformAdmin(async (tx) => (await tx.platformSettings.findFirst())?.goLiveListingFloor ?? 20);
    storeId = await asPlatformAdmin(async (tx) => {
      const store = await tx.store.create({
        data: { slug, name: "E2E Lagos Corner", status: "setup", stripeOnboardingStatus: "complete", stripeAccountId: `acct_${slug}`, hours: HOURS, timezone: "America/Chicago", timezoneSetAt: new Date(), pickupEnabled: true },
      });
      await tx.storeSubscription.create({ data: { storeId: store.id, plan: "starter", status: "active", stripeSubscriptionId: `sub_${slug}` } });
      const owner = await tx.user.findUniqueOrThrow({ where: { email: "owner@mama-ngozi.test" } });
      await tx.storeMembership.create({ data: { storeId: store.id, userId: owner.id, role: "owner" } });
      for (let i = 0; i < floor; i++) {
        const listing = await tx.listing.create({ data: { storeId: store.id, customName: i === 0 ? "Puna yam" : `Item ${i}`, price: 299, stockMode: "status", status: "in_stock" } });
        if (i === 0) yamId = listing.id;
      }
      await tx.storeInvite.create({
        data: { storeId: store.id, email: staffEmail, role: "staff", tokenHash: createHash("sha256").update(inviteToken).digest("hex"), expiresAt: new Date(Date.now() + 3_600_000), invitedById: owner.id },
      });
      return store.id;
    });
  });

  test.afterAll(async () => {
    await asPlatformAdmin(async (tx) => {
      const staff = await tx.user.findUnique({ where: { email: staffEmail } });
      await tx.stockEvent.deleteMany({ where: { storeId } });
      await tx.listing.deleteMany({ where: { storeId } });
      await tx.storeInvite.deleteMany({ where: { storeId } });
      await tx.storeMembership.deleteMany({ where: { storeId } });
      await tx.auditLog.deleteMany({ where: { storeId } });
      await tx.storeSubscription.deleteMany({ where: { storeId } });
      await tx.store.deleteMany({ where: { id: storeId } });
      if (staff) {
        await tx.twoFactor.deleteMany({ where: { userId: staff.id } });
        await tx.session.deleteMany({ where: { userId: staff.id } });
        await tx.account.deleteMany({ where: { userId: staff.id } });
        await tx.user.delete({ where: { id: staff.id } });
      }
    });
  });

  test("staff change stock from Products, cannot add or price listings, and sign out", async ({ page }) => {
    await page.goto(`/invite/${inviteToken}`);
    await page.getByLabel("Full name").fill("Ada Staff");
    await page.getByLabel("Password").fill("E2eInvitePass-123!");
    const enabled = page.waitForResponse((res) => res.url().includes("/api/auth/two-factor/enable"));
    await page.getByRole("button", { name: "Create account & continue" }).click();
    const totpURI = ((await (await enabled).json()) as { totpURI: string }).totpURI;
    await page.getByLabel("Verification code").fill(generateTOTP(new URL(totpURI).searchParams.get("secret")!));
    await page.getByRole("button", { name: "Verify & join store" }).click();
    await expect(page.getByRole("heading", { name: "Save your backup codes" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /saved them/ }).click();
    await page.waitForURL((url) => url.pathname === "/store-admin", { timeout: 15_000 });

    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.getByRole("link", { name: /Products/ }).click();
    await expect(page.locator("h1")).toHaveText("Products");
    await expect(page.getByRole("button", { name: "Add listing" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Import CSV/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit Puna yam" })).toHaveCount(0);

    await page.getByRole("button", { name: "Update stock for Puna yam" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/price/i)).toHaveCount(0);
    await dialog.getByLabel("Stock status").click();
    await page.getByRole("option", { name: "Out of stock" }).click();
    await dialog.getByRole("button", { name: "Save stock" }).click();
    await expect(page.getByText("Stock updated")).toBeVisible();
    const yam = await asPlatformAdmin((tx) => tx.listing.findUniqueOrThrow({ where: { id: yamId } }));
    expect(yam).toMatchObject({ status: "out_of_stock", price: 299 });
    await shoot(page, "staff-products");

    await page.goto("/store-admin");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL((url) => url.pathname === "/store-admin/sign-in", { timeout: 15_000 });
    await page.goto("/store-admin");
    await expect(page).toHaveURL(/\/store-admin\/sign-in/);
  });

  test("the owner sees the store's address, confirms Go live, and the store is live and listed", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin?store=${slug}`);
    await expect(page.getByRole("heading", { level: 1, name: "E2E Lagos Corner" })).toBeVisible();

    const address = `http://localhost:${E2E_PORT}/?store=${slug}`;
    await expect(page.getByRole("link", { name: "View store" })).toHaveAttribute("href", address);
    await expect(page.getByText(address.replace("http://", ""))).toBeVisible();
    await expect(page.getByText(/place one small order/)).toHaveCount(0);
    await expect(page.locator("#go-live-hint")).toContainText("$35.00");
    await shoot(page, "owner-ready");

    await page.getByRole("button", { name: "Go live", exact: true }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("directory");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    expect((await asPlatformAdmin((tx) => tx.store.findUniqueOrThrow({ where: { id: storeId } }))).status).toBe("setup");

    await page.getByRole("button", { name: "Go live", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Go live now" }).click();
    const live = page.getByRole("status").filter({ hasText: "You're live" });
    await expect(live).toBeVisible();
    await expect(live.getByRole("link", { name: /\?store=/ })).toHaveAttribute("href", address);
    await expect(live.getByRole("link", { name: "Directory listing" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Get ready to go live" })).toHaveCount(0);
    const store = await asPlatformAdmin((tx) => tx.store.findUniqueOrThrow({ where: { id: storeId } }));
    expect(store).toMatchObject({ status: "active", listed: true });
    await shoot(page, "owner-live");

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL((url) => url.pathname === "/store-admin/sign-in", { timeout: 15_000 });
  });
});
