import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const NAME = `E2E metro ${Date.now().toString(36)}`;

async function asPlatformAdmin<T>(run: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    return await run(prisma);
  } finally {
    await prisma.$disconnect();
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

test.describe("metros (#577)", () => {
  test.afterAll(async () => {
    await asPlatformAdmin((prisma) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`UPDATE stores SET metro_id = NULL WHERE metro_id IN (SELECT id FROM metros WHERE name = ${NAME})`;
        await tx.$executeRaw`DELETE FROM metros WHERE name = ${NAME}`;
      }),
    );
  });

  test("a platform admin adds a metro, puts a store in it and sees the store on its readiness report", async ({ page }) => {
    await adminSignIn(page);
    await page.goto("/admin/metros");
    const form = page.getByRole("form", { name: "New metro" });
    await form.getByLabel("Name").fill(NAME);
    await form.getByLabel("States").fill("MD, DC");
    await form.getByLabel("Centre latitude").fill("38.9");
    await form.getByLabel("Centre longitude").fill("-77.03");
    await form.getByLabel("Radius in miles").fill("40");
    await form.getByLabel("DoorDash first").check();
    await form.getByRole("button", { name: "Add metro" }).click();
    await page.waitForURL(/\/admin\/metros\/[^/]+$/);
    await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();
    const metroUrl = page.url();

    const storeId = await asPlatformAdmin(async (prisma) => (await prisma.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } })).id);
    await page.goto(`/admin/stores/${storeId}`);
    await page.getByRole("combobox", { name: "Metro" }).selectOption({ label: NAME });
    await page.getByRole("button", { name: "Save metro" }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

    await page.goto(metroUrl);
    await expect(page.getByTestId(`metro-store-${storeId}`)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sales tax sign-off" })).toBeVisible();
  });
});
