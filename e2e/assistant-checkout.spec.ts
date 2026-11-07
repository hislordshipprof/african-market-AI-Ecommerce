import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { generateTOTP } from "./totp";
import { storeUrl } from "./urls";

const origin = storeUrl("mama-ngozi");
const OWNER_EMAIL = "owner@mama-ngozi.test";
const OWNER_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

test.beforeAll(async () => {
  const raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const store = await raw.store.findUnique({ where: { slug: "mama-ngozi" }, select: { id: true, stripeAccountId: true } });
  if (!store) throw new Error("mama-ngozi is not seeded");
  await raw.store.update({
    where: { slug: "mama-ngozi" },
    data: {
      stripeOnboardingStatus: "complete",
      stripeAccountId: store.stripeAccountId ?? "acct_e2e_mama_ngozi",
    },
  });
  await raw.appRateLimit.deleteMany({ where: { key: { startsWith: "assistant:" } } });
  await raw.$disconnect();
  await fetch(`http://127.0.0.1:${process.env.E2E_PORT || "3200"}/api/storefront/revalidate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.STOREFRONT_REVALIDATION_SECRET ?? "e2e-storefront-revalidate"}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ stores: [{ id: store.id, slug: "mama-ngozi" }] }),
  });
});

async function say(page: Page, text: string) {
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await dialog.getByTestId("assistant-composer").fill(text);
  await dialog.getByTestId("assistant-send").click();
  return dialog;
}

async function drawPayableCard(page: Page) {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  for (let time = 0; time < 2; time += 1) {
    await say(page, "add two egusi");
    await expect(dialog.getByText("Here is what I found.", { exact: true })).toHaveCount(time + 1, { timeout: 20_000 });
  }
  await say(page, "checkout");
  const contact = dialog.getByRole("button", { name: "Save contact" });
  const place = dialog.getByTestId("assistant-place-order");
  await expect(contact.or(place)).toBeVisible({ timeout: 20_000 });
  if (await contact.isVisible()) {
    await dialog.getByLabel("Name").fill("Ada Okonkwo");
    await dialog.getByLabel("Email").fill("ada@example.com");
    await dialog.getByLabel("Phone").fill("2025550147");
    await contact.click();
    await expect(dialog.getByText("Contact saved")).toBeVisible({ timeout: 20_000 });
    await say(page, "checkout");
  }
  await expect(place).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(/cancel for \d+ minutes/i)).toBeVisible();
  return dialog;
}

async function storeOwnerOrders(page: Page) {
  await page.goto(`${storeUrl()}/store-admin/sign-in?store=mama-ngozi`);
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
  await page.click("button[type='submit']");
  await page.waitForURL(
    (url) => url.pathname.startsWith("/store-admin") && !url.pathname.includes("sign-in"),
    { timeout: 15_000 },
  );
  await page.goto(`${storeUrl()}/store-admin/orders?store=mama-ngozi`);
  await expect(page.locator("h1", { hasText: "Orders" })).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async () => {
  const raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  await raw.appRateLimit.deleteMany({ where: { key: { startsWith: "assistant:" } } });
  await raw.$disconnect();
});

test("a customer draws a card, taps to place, cancels, and the store cannot see it yet", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const dialog = await drawPayableCard(page);
  if (process.env.ASSISTANT_CHECKOUT_SHOTS === "1") {
    const card = dialog.getByTestId("assistant-checkout-card").last();
    await card.scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 1440, height: 900 });
    await card.screenshot({ path: "test-results/assistant-checkout-shots-1440-light.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await card.screenshot({ path: "test-results/assistant-checkout-shots-390-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await card.screenshot({ path: "test-results/assistant-checkout-shots-390-dark.png" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await card.screenshot({ path: "test-results/assistant-checkout-shots-1440-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
  }
  await dialog.getByTestId("assistant-place-order").click();
  const orderLink = dialog.getByRole("link", { name: /Order placed/ });
  await expect(orderLink).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId("assistant-cancel-order").click();
  await expect(dialog.getByText("Cancelled")).toBeVisible({ timeout: 20_000 });

  const store = await browser.newPage();
  await storeOwnerOrders(store);
  await expect(store.getByText("Ada Okonkwo")).toHaveCount(0);
  await store.close();
});

test("a changed basket replaces the card and needs a new tap", async ({ page }) => {
  test.setTimeout(120_000);
  const dialog = await drawPayableCard(page);
  await say(page, "add two egusi");
  await expect(dialog.getByText("Here is what I found.", { exact: true })).toHaveCount(3, { timeout: 20_000 });
  await dialog.getByTestId("assistant-place-order").click();
  await expect(dialog.getByText("The total changed. Review the new card.")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole("link", { name: /Order placed/ })).toHaveCount(0);
  await expect(dialog.getByTestId("assistant-place-order")).toBeVisible();
});

test("normal checkout is refused while an assistant attempt is live", async ({ page }) => {
  test.setTimeout(120_000);
  const dialog = await drawPayableCard(page);
  await page.route("**/api/assistant/checkout/confirm", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes('"phase":"complete"')) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  const reserved = page.waitForResponse((res) => res.url().includes("/api/assistant/checkout/confirm") && res.ok());
  await dialog.getByTestId("assistant-place-order").click();
  await reserved;
  await expect(dialog.getByRole("link", { name: /Order placed/ })).toHaveCount(0);
  await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: `${origin}/` }]);
  await page.goto(`${origin}/checkout`);
  await page.getByRole("button", { name: /Pickup/ }).click();
  await page.getByLabel("Full name").fill("Ada Okonkwo");
  await page.getByLabel("Phone number (required)").fill("2025550147");
  await page.getByLabel("Email (required)").fill("ada@example.com");
  await expect(page.getByText("Card entry is simulated")).toBeVisible({ timeout: 20_000 });
  const pay = page.getByRole("button", { name: /^Pay/ });
  await expect(async () => {
    await pay.click();
    await expect(page.getByText("A payment is already in progress for this basket.")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
});
