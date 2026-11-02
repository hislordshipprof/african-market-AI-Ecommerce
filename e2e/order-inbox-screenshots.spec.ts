import { test, expect, type Page } from "@playwright/test";
import { generateTOTP } from "./totp";

const OWNER_EMAIL = "owner@mama-ngozi.test";
const OWNER_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const ORDERS_URL = "/store-admin/orders?store=mama-ngozi";

async function storeOwnerSignIn(page: Page) {
  await page.goto("/store-admin/sign-in?store=mama-ngozi");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 10000 });
  const code = generateTOTP(SEED_TOTP_SECRET);
  await page.getByLabel("Verification code").fill(code);
  await page.click("button[type='submit']");
  await page.waitForURL(
    (url) => url.pathname.startsWith("/store-admin") && !url.pathname.includes("sign-in"),
    { timeout: 15000 },
  );
}

for (const width of [390, 1440]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`order inbox screenshot ${width}px ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await page.waitForTimeout(2000);

      const orderCard = page.locator("button", { hasText: "#1003" });
      if (await orderCard.isVisible()) {
        await orderCard.click();
        await page.waitForTimeout(1000);
      }

      await page.screenshot({
        path: `screenshots/order-inbox-${width}px-${scheme}.png`,
        fullPage: false,
      });
    });
  }
}
