import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { storeUrl } from "./urls";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

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

async function asPlatformAdmin<T>(work: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    return await work(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

test.describe("Go-live gate (#555)", () => {
  const slug = `e2e-golive-${Date.now().toString(36)}`;
  let storeId = "";

  test.beforeAll(async () => {
    storeId = await asPlatformAdmin(async (prisma) => {
      const store = await prisma.store.create({
        data: { slug, name: "E2E Opening Market", status: "setup", stripeOnboardingStatus: "complete", stripeAccountId: `acct_${slug}`, pickupEnabled: true },
      });
      return store.id;
    });
  });

  test.afterAll(async () => {
    await asPlatformAdmin((prisma) => prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.auditLog.deleteMany({ where: { storeId } }),
      prisma.store.deleteMany({ where: { id: storeId } }),
    ]));
  });

  test("a store in setup shows Opening soon and refuses checkout; a platform admin forces it live with a reason", async ({ page }) => {
    await page.goto(`${storeUrl(slug)}/`);
    await expect(page.locator("h1")).toHaveText("E2E Opening Market");
    await expect(page.getByText("Opening soon")).toBeVisible();

    await page.goto(`${storeUrl(slug)}/checkout`);
    await expect(page.getByText("This store is opening soon. Checkout opens when it goes live.")).toBeVisible();

    await adminSignIn(page);
    await page.goto(`/admin/stores/${storeId}`);
    const section = page.getByRole("region", { name: "Go live" });
    await expect(section.getByTestId("store-status")).toContainText("Setup");
    await expect(section.getByTestId("go-live-payouts")).toHaveAttribute("data-done", "true");
    await expect(section.getByTestId("go-live-hours")).toHaveAttribute("data-done", "false");
    await expect(section.getByTestId("go-live-listings")).toHaveAttribute("data-done", "false");

    await section.getByLabel("Reason").fill("E2E launch partner");
    await section.getByRole("button", { name: "Go live now" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/stores/${storeId}\\?goLive=forced`));
    await expect(section.getByTestId("store-status")).toContainText("Live");

    await page.goto(`${storeUrl(slug)}/`);
    await expect(page.getByText("Opening soon")).toHaveCount(0);
  });
});
