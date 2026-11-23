import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { E2E_PORT, storeUrl } from "./urls";
import { insertShopperAccount } from "./account-fixture";
import { deleteBatchOrders, deleteGuestOrder, insertGuestOrder, insertRecoveryOrder, insertTrackingOrder } from "./order-fixture";

const base = storeUrl("mama-ngozi");
const apiBase = `http://localhost:${E2E_PORT}`;
const LIVE_ORDER = 736_001;
const REFUNDED_ORDER = 736_002;
const DONE_ORDER = 736_003;
const RUN = Date.now();

async function signIn(page: Page, request: APIRequestContext, email: string) {
  await page.goto(`${base}/account/sign-in`);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.locator("[data-slot='card-title']")).toContainText("Check your email", { timeout: 10000 });
  const { token } = await (await request.get(`${apiBase}/api/e2e/magic-link-token?email=${encodeURIComponent(email)}`)).json();
  await page.goto(`${base}/api/auth/magic-link/verify?token=${token}&callbackURL=/account`);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible({ timeout: 15000 });
}

const top = async (page: Page, name: string) => (await page.getByRole("heading", { name, exact: true }).boundingBox())!.y;

test.describe("account and tracking lead with what the customer needs now (#736)", () => {
  test.afterAll(async () => {
    await deleteBatchOrders([LIVE_ORDER, REFUNDED_ORDER, DONE_ORDER]);
  });

  test("account lists recent orders first, with status, date, total and a tracking link", async ({ page, request }) => {
    const email = `e2e-736-orders-${RUN}@test.example`;
    const seeded = await insertGuestOrder({ email, name: "Ola Orders", phone: "+15550007360" });
    try {
      await signIn(page, request, email);
      const row = page.getByRole("link", { name: new RegExp(`Order #${seeded.number}\\b`) });
      await expect(row).toHaveAttribute("href", `/order/${seeded.orderId}`);
      await expect(row).toContainText("Completed");
      await expect(row).toContainText("$12.50");
      await expect(row).toContainText(/\w{3} \d{1,2}, \d{4}/);
      expect(await top(page, "Your orders")).toBeLessThan(await top(page, "Personal details"));
      expect(await top(page, "Your orders")).toBeLessThan(await top(page, "Saved addresses"));
    } finally {
      await deleteGuestOrder(seeded);
    }
  });

  test("an account with no orders offers Start shopping, and the page keeps body 16px, titles 22px and 24px between sections", async ({ page, request }) => {
    const email = `e2e-736-empty-${RUN}@test.example`;
    await insertShopperAccount({ email, password: "E2eTestPass-123!", name: "Ema Empty" });
    await signIn(page, request, email);
    const orders = page.locator(".flow-card", { has: page.getByRole("heading", { name: "Your orders" }) });
    await expect(orders.getByRole("link", { name: "Start shopping" })).toHaveAttribute("href", "/");
    await expect(orders.getByRole("heading", { name: "Your orders" })).toHaveCSS("font-size", "22px");
    await expect(orders.locator("p").first()).toHaveCSS("font-size", "16px");
    await expect(page.locator(".sf-account")).toHaveCSS("row-gap", "24px");
    await expect(page.locator(".sf-account-form").first()).toHaveCSS("row-gap", "16px");
  });

  test("tracking opens on status, the store-time slot, the swap prompt and the courier, before the receipt", async ({ page }) => {
    const token = `e2e-736-live-${RUN}`;
    await insertTrackingOrder({
      number: LIVE_ORDER, token, status: "SUBSTITUTION_PENDING", fulfillment: "courier",
      pickupSlot: "2026-12-01T20:00:00.000Z", courier: { name: "Ama", trackingUrl: "https://example.com/track/736" },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/order/${token}`);
    const status = page.getByRole("region", { name: "Waiting for your answer" });
    await expect(status).toBeVisible();
    // mama-ngozi is in Houston: 20:00Z is 2:00 PM Central.
    await expect(status).toContainText("Tue, Dec 1, 2:00 PM CST");
    await expect(status.getByRole("link", { name: "Choose now" })).toHaveAttribute("href", `/order/${token}/substitutions`);
    await expect(status).toContainText("Ama");
    await expect(status.getByRole("link", { name: "Track your courier" })).toHaveAttribute("href", "https://example.com/track/736");
    expect(await top(page, "Waiting for your answer")).toBeLessThan(await top(page, "Receipt"));
    await expect(status.getByRole("heading", { name: "Waiting for your answer" })).toHaveCSS("font-size", "22px");
    await expect(page.getByRole("progressbar")).toHaveCount(0);
  });

  test("a finished order offers the report window at the top", async ({ page }) => {
    const token = `e2e-736-done-${RUN}`;
    await insertRecoveryOrder({ number: DONE_ORDER, token });
    await page.goto(`${base}/order/${token}`);
    const status = page.getByRole("region", { name: "Completed" });
    await expect(status.getByRole("link", { name: "Report a problem" })).toHaveAttribute("href", `/order/${token}/report`);
    expect(await top(page, "Completed")).toBeLessThan(await top(page, "Receipt"));
  });

  test("a cancelled order says so at the top with the refunded amount", async ({ page }) => {
    const token = `e2e-736-refund-${RUN}`;
    await insertTrackingOrder({ number: REFUNDED_ORDER, token, status: "CANCELLED", refundCents: 1250 });
    await page.goto(`${base}/order/${token}`);
    const status = page.getByRole("region", { name: "Cancelled" });
    await expect(status).toContainText("We refunded $12.50 to your card.");
    await expect(status.getByRole("link", { name: "Choose now" })).toHaveCount(0);
    expect(await top(page, "Cancelled")).toBeLessThan(await top(page, "Receipt"));
  });
});
