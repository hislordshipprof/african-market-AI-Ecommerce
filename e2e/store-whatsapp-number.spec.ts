import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";
import { generateTOTP } from "./totp";

const SLUG = "mama-ngozi";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? "e2e-whatsapp-app-secret";
// Unique per run: phone_number_id is unique platform-wide.
const PHONE_ID = String(9_000_000_000 + Number(String(Date.now()).slice(-9)));
const WABA_ID = "102938475610";

async function clearNumber() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the store number e2e");
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
  try {
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.$executeRaw`DELETE FROM store_whatsapp_numbers WHERE store_id = (SELECT id FROM stores WHERE slug = ${SLUG})`,
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

async function shoot(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [["1280px", { width: 1280, height: 900 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      await page.screenshot({ path: `${SHOTS}/558-${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.describe.configure({ mode: "serial" });

test.describe("store WhatsApp number (#558, fake provider)", () => {
  test.beforeAll(clearNumber);
  test.afterAll(clearNumber);

  test("the owner links the store's number in test mode, with coexistence on", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/whatsapp?store=${SLUG}`);
    const section = page.getByRole("region", { name: "Your store's WhatsApp number" });
    await expect(section.getByText("No number linked")).toBeVisible();
    await shoot(page, "owner-empty");

    await section.getByLabel("WhatsApp Business account ID").fill(WABA_ID);
    await section.getByLabel("Phone number ID").fill(PHONE_ID);
    await section.getByLabel("WhatsApp number").fill("(404) 555-0188");
    await expect(section.getByLabel(/Keep using the WhatsApp Business app/)).toBeChecked();
    await section.getByRole("button", { name: "Link number" }).click();

    await expect(section.getByText("Live")).toBeVisible();
    await expect(section.getByText("+1 (404) 555-0188")).toBeVisible();
    await expect(section.getByText("Shared with the WhatsApp Business app")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("fake-business-token");
    await shoot(page, "owner-live");
  });

  test("the webhook checks the signature first and answers 200 for a store number and an unknown one", async ({ request }) => {
    const body = (phoneNumberId: string) => JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: WABA_ID, changes: [{ field: "messages", value: {
        metadata: { phone_number_id: phoneNumberId },
        messages: [{ from: "14045550123", id: `wamid.e2e-558-${phoneNumberId}-${Date.now()}`, type: "text", text: { body: "hi" } }],
      } }] }],
    });
    const sign = (raw: string, secret: string) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const raw = body(PHONE_ID);
    const bad = await request.post("/api/webhooks/whatsapp", { data: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, "wrong") } });
    expect(bad.status()).toBe(401);
    const ok = await request.post("/api/webhooks/whatsapp", { data: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, APP_SECRET) } });
    expect(ok.status()).toBe(200);
    const unknown = body("1234509876");
    const dropped = await request.post("/api/webhooks/whatsapp", { data: unknown, headers: { "content-type": "application/json", "x-hub-signature-256": sign(unknown, APP_SECRET) } });
    expect(dropped.status()).toBe(200);
  });

  test("a platform admin sees the number on the store page and disconnects it", async ({ page }) => {
    await page.goto("/admin/sign-in");
    await page.getByLabel("Email").fill("admin@platform.test");
    await page.getByLabel("Password").fill(process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!");
    await page.click("button[type='submit']");
    await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 10000 });
    await page.getByLabel("Verification code").fill(generateTOTP(process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP"));
    await page.click("button[type='submit']");
    await page.waitForURL("**/admin/stores", { timeout: 15000 });

    await page.getByRole("row", { name: /Mama Ngozi/ }).getByRole("link", { name: "Edit" }).click();
    const section = page.getByRole("region", { name: "Store WhatsApp number" });
    await expect(section.getByText("Live")).toBeVisible();
    await expect(section.getByText(PHONE_ID)).toBeVisible();
    await expect(section.getByText("Shared (coexistence)")).toBeVisible();
    await shoot(page, "admin-live");

    await section.getByRole("button", { name: "Disconnect number" }).click();
    await expect(section.getByText("Disconnected")).toBeVisible();
    await expect(section.getByRole("button", { name: "Link number" })).toBeVisible();
    await shoot(page, "admin-disconnected");
  });
});
