import { expect, test } from "@playwright/test";
import { generateTOTP } from "./totp";
import { deleteInboxOrder, insertInboxOrder } from "./order-fixture";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

test("an admin resolves a refund-failed order from the admin orders view", async ({ page }) => {
  const number = 18664;
  await insertInboxOrder({
    number,
    status: "REFUND_FAILED",
    capturedAmountCents: 2500,
    refundId: "re_e2e_18664",
  });
  try {
    await page.goto("/admin/sign-in");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.click("button[type='submit']");
    await page.getByLabel("Verification code").waitFor({ state: "visible" });
    await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
    await page.click("button[type='submit']");
    await page.waitForURL("**/admin/stores");

    await page.goto("/admin/orders");
    const row = page.getByTestId(`refund-row-${number}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("amount-owed")).toHaveText("$25.00");
    await page.getByLabel("Resolution note").fill("Paid customer by Zelle 11/05");
    await page.getByRole("button", { name: "Mark resolved" }).click();
    await expect(row).toHaveCount(0);
  } finally {
    await deleteInboxOrder(number);
  }
});
