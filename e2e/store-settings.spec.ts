import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { storeOwnerSignIn } from "./store-owner-auth";
import { generateTOTP } from "./totp";
import { storeUrl } from "./urls";

const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

async function asPlatformAdmin<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
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

async function adminSignIn(page: Page) {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
  await page.click("button[type='submit']");
  await page.waitForURL("**/admin", { timeout: 15_000 });
}

async function shoot(page: Page, name: string, ticket = "786") {
  mkdirSync(SHOTS, { recursive: true });
  for (const [scheme, width] of [["light", 1280], ["dark", 390]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 900 });
    // Let the page lay out again at the new width before the full-page capture.
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/${ticket}-${name}-${width}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

// A new store as a store application leaves it: zone guessed from the address, no hours, pickup off, and no map point.
test.describe.serial("Owner store settings (#786)", () => {
  const slug = `e2e-786-${Date.now().toString(36)}`;
  let storeId = "";

  test.beforeAll(async () => {
    const floor = await asPlatformAdmin(async (tx) => (await tx.platformSettings.findFirst())?.goLiveListingFloor ?? 20);
    storeId = await asPlatformAdmin(async (tx) => {
      const store = await tx.store.create({
        data: { slug, name: "E2E Accra Pantry", status: "setup", stripeOnboardingStatus: "complete", stripeAccountId: `acct_${slug}`, timezone: "America/New_York" },
      });
      await tx.storeSubscription.create({ data: { storeId: store.id, plan: "starter", status: "active", stripeSubscriptionId: `sub_${slug}` } });
      const owner = await tx.user.findUniqueOrThrow({ where: { email: "owner@mama-ngozi.test" } });
      await tx.storeMembership.create({ data: { storeId: store.id, userId: owner.id, role: "owner" } });
      for (let i = 0; i < floor; i++) {
        await tx.listing.create({ data: { storeId: store.id, customName: `Item ${i}`, price: 299, stockMode: "status", status: "in_stock" } });
      }
      return store.id;
    });
  });

  test.afterAll(async () => {
    await asPlatformAdmin(async (tx) => {
      await tx.listing.deleteMany({ where: { storeId } });
      await tx.storeMembership.deleteMany({ where: { storeId } });
      await tx.auditLog.deleteMany({ where: { storeId } });
      await tx.storeSubscription.deleteMany({ where: { storeId } });
      await tx.store.deleteMany({ where: { id: storeId } });
    });
  });

  test("the owner sets hours, zone, pickup, a $0 minimum, phone and about; the checklist follows; go live is honest about the directory", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin?store=${slug}`);
    await expect(page.getByTestId("go-live-hours")).toHaveAttribute("data-done", "false");
    await expect(page.getByTestId("go-live-fulfillment")).toHaveAttribute("data-done", "false");
    await expect(page.getByText(/platform team sets this/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Fix Hours and time zone set" })).toHaveAttribute("href", `/store-admin/settings?store=${slug}`);
    await expect(page.getByText("Coming soon")).toHaveCount(0);

    await page.getByRole("link", { name: /^Settings/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByText("Your hours are not set yet")).toBeVisible();
    await expect(page.getByText("We guessed this from your address")).toBeVisible();

    await page.getByRole("switch", { name: "Sunday open" }).click();
    await page.getByLabel("Monday closes").fill("17:30");
    await page.getByLabel("Time zone").click();
    await page.getByRole("option", { name: "Central" }).click();
    await page.getByRole("switch", { name: "Pickup in store" }).click();
    await page.getByLabel("Minimum order").fill("0");
    await page.getByLabel("Store phone").fill("(312) 555-0142");
    await page.getByLabel("About the store").fill("Family shop since 2009: yams, palm oil and fresh fish on Fridays.");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await shoot(page, "settings");

    await page.reload();
    await expect(page.getByLabel("Monday closes")).toHaveValue("17:30");
    await expect(page.getByRole("switch", { name: "Sunday open" })).not.toBeChecked();
    await expect(page.getByLabel("Minimum order")).toHaveValue("0");
    await expect(page.getByLabel("Store phone")).toHaveValue("+13125550142");
    await expect(page.getByText("Your hours are read in this time zone.")).toBeVisible();
    const saved = await asPlatformAdmin((tx) => tx.store.findUniqueOrThrow({ where: { id: storeId } }));
    expect(saved).toMatchObject({ timezone: "America/Chicago", pickupEnabled: true, minimumOrderCents: 0, phone: "+13125550142" });
    expect(saved.hours).toMatchObject({ monday: "9:00 AM - 5:30 PM", sunday: "Closed" });
    expect(await asPlatformAdmin((tx) => tx.auditLog.count({ where: { storeId, action: "store.settings" } }))).toBe(1);

    await page.goto(`/store-admin?store=${slug}`);
    await expect(page.getByTestId("go-live-hours")).toHaveAttribute("data-done", "true");
    await expect(page.getByTestId("go-live-fulfillment")).toHaveAttribute("data-done", "true");
    await page.getByRole("button", { name: "Go live", exact: true }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("appears in the Store directory once the platform team confirms its address");
    await expect(confirm).not.toContainText("is listed");
    await confirm.getByRole("button", { name: "Go live now" }).click();
    const live = page.getByRole("status").filter({ hasText: "You're live" });
    await expect(live).toContainText("once the platform team confirms its address");
    await expect(live).not.toContainText("is listed");
    await shoot(page, "live-unlocated");

    // The storefront shows the about text and the hours as saved.
    await page.goto(`${storeUrl(slug)}/`);
    await expect(page.getByTestId("trust-strip")).toContainText("Family shop since 2009");
    await expect(page.getByTestId("trust-strip")).toContainText("9:00 AM - 5:30 PM");
  });

  test("the owner sets pickup slots inside the hours; the form says when no slot fits in 7 days (#807)", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/settings?store=${slug}`);
    const slotsCard = page.locator("section", { has: page.getByRole("switch", { name: "Pickup slots" }) });
    await page.getByRole("switch", { name: "Pickup slots" }).click();
    // Turning slots on starts each day at its opening hours.
    await expect(page.getByLabel("Monday", { exact: true })).toHaveValue("9:00 AM - 5:30 PM");
    await expect(page.getByLabel("Sunday", { exact: true })).toHaveValue("");
    await expect(slotsCard.getByRole("status")).toHaveCount(0);

    // Only evening times, after every closing: no slot in the next 7 days.
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]) {
      await page.getByLabel(day, { exact: true }).fill("9:00 PM - 11:00 PM");
    }
    await expect(slotsCard.getByRole("status")).toContainText("no slot in the next 7 days");
    await shoot(page, "owner-slots-warning", "807");

    await page.getByLabel("Saturday", { exact: true }).fill("10:00 AM - 2:00 PM");
    await expect(slotsCard.getByRole("status")).toHaveCount(0);
    await slotsCard.getByLabel("Slot length").fill("30");
    await slotsCard.getByLabel("Orders per slot").fill("6");
    await slotsCard.getByLabel("Lead time").fill("180");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await shoot(page, "owner-slots-saved", "807");

    const saved = await asPlatformAdmin((tx) => tx.store.findUniqueOrThrow({ where: { id: storeId } }));
    expect(saved.pickupSlotSettings).toMatchObject({ slotMinutes: 30, capacity: 6, leadMinutes: 180 });
    expect(saved.storeDeliverySlotSettings).toBeNull();
    const audit = await asPlatformAdmin((tx) => tx.auditLog.findFirstOrThrow({ where: { storeId, action: "store.settings" }, orderBy: { createdAt: "desc" } }));
    expect(audit.after).toMatchObject({ pickupSlotSettings: { slotMinutes: 30, capacity: 6 } });
  });

  test("the platform admin edits hours with the same editor; the slug pattern compiles and the hint shows the real address", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await adminSignIn(page);
    await page.goto(`/admin/stores/${storeId}`);
    await expect(page.getByTestId("slug-address")).toContainText(slug);
    await expect(page.getByText(/yourplatform/)).toHaveCount(0);
    await expect(page.getByLabel("Monday closes")).toHaveValue("17:30");
    await page.getByLabel("Tuesday closes").fill("18:00");
    // A pattern the browser cannot compile is ignored, so a bad slug would pass the field.
    await page.locator("#slug").fill("-bad");
    expect(await page.locator("#slug").evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
    await page.locator("#slug").fill(slug);
    await shoot(page, "admin-hours");
    // The admin form warns the same way (#807).
    await page.locator("#pickupSlotsSat").fill("9:00 PM - 11:00 PM");
    await expect(page.getByRole("status").filter({ hasText: "no slot in the next 7 days" })).toBeVisible();
    await page.getByRole("status").filter({ hasText: "no slot in the next 7 days" }).scrollIntoViewIfNeeded();
    await shoot(page, "admin-slots-warning", "807");
    await page.locator("#pickupSlotsSat").fill("10:00 AM - 2:00 PM");
    await expect(page.getByRole("status").filter({ hasText: "no slot in the next 7 days" })).toHaveCount(0);
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL("**/admin/stores", { timeout: 15_000 });
    const saved = await asPlatformAdmin((tx) => tx.store.findUniqueOrThrow({ where: { id: storeId } }));
    expect(saved.hours).toMatchObject({ monday: "9:00 AM - 5:30 PM", tuesday: "9:00 AM - 6:00 PM", sunday: "Closed" });
    expect(errors.filter((e) => /pattern/i.test(e))).toEqual([]);
  });
});
