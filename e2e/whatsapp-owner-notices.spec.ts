import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";

const SLUG = "mama-ngozi";
const OWNER_EMAIL = "owner@mama-ngozi.test";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";
// Verified wa_ids are unique platform-wide, so each run takes a fresh one.
const WA_ID = `1404${String(200 + Math.floor(Math.random() * 800))}${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;

/** Test setup only: the owner's verified link, as answering a WhatsApp code leaves it; or none. */
async function setLink(linked: boolean) {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the owner notices e2e");
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
  try {
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.$executeRaw`
        DELETE FROM owner_whatsapp_links
        WHERE store_id = (SELECT id FROM stores WHERE slug = ${SLUG})
          AND user_id = (SELECT id FROM users WHERE email = ${OWNER_EMAIL})`,
      ...(linked
        ? [prisma.$executeRaw`
          INSERT INTO owner_whatsapp_links (id, store_id, user_id, phone_number, wa_id, verified, verified_at, updated_at)
          SELECT ${crypto.randomUUID()}, s.id, u.id, ${`+${WA_ID}`}, ${WA_ID}, true, now(), now()
          FROM stores s, users u WHERE s.slug = ${SLUG} AND u.email = ${OWNER_EMAIL}`]
        : []),
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

async function shoot(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [["1440px", { width: 1440, height: 900 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      await page.screenshot({ path: `${SHOTS}/144-${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe.configure({ mode: "serial" });

test.describe("copilot alerts and digest on WhatsApp (#144)", () => {
  test.beforeAll(() => setLink(true));
  test.afterAll(() => setLink(false));

  test("the owner turns stock alerts and the daily digest on WhatsApp on, and they stay on", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/whatsapp?store=${SLUG}`);
    const alerts = page.getByRole("switch", { name: "Stock alerts" });
    const digest = page.getByRole("switch", { name: "Daily digest" });
    await expect(alerts).not.toBeChecked();
    await expect(digest).not.toBeChecked();
    await shoot(page, "notices-off");

    await alerts.click();
    await expect(alerts).toBeChecked();
    await expect(alerts).toBeEnabled();
    await digest.click();
    await expect(digest).toBeChecked();
    await expect(digest).toBeEnabled();

    await page.reload();
    await expect(page.getByRole("switch", { name: "Stock alerts" })).toBeChecked();
    await expect(page.getByRole("switch", { name: "Daily digest" })).toBeChecked();
    await shoot(page, "notices-on");
  });
});
