import { test, expect, type Page } from "@playwright/test";
import { E2E_PORT, storeUrl } from "./urls";
import { insertShopperAccount } from "./account-fixture";
import { deleteBatchOrders, insertRecoveryOrder } from "./order-fixture";

const base = storeUrl("mama-ngozi");
const apiBase = `http://localhost:${E2E_PORT}`;
const REPORT_ORDER = 724_001;
const SWAP_ORDER = 724_002;
const REPORT_TOKEN = `e2e-report-${Date.now()}`;
const SWAP_TOKEN = `e2e-swap-${Date.now()}`;

/** Holds every server action until release(), then fails it the way a dropped connection does. */
async function failServerActions(page: Page) {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/*", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await held;
      await route.abort("connectionreset");
      return;
    }
    await route.fallback();
  });
  return release;
}

test.describe("customer recovery (#724)", () => {
  test.afterAll(async () => {
    await deleteBatchOrders([REPORT_ORDER, SWAP_ORDER]);
  });

  test("the real report form has 48px fields, a 120px note, 16px text and a visible focus ring", async ({ page }) => {
    await insertRecoveryOrder({ number: REPORT_ORDER, token: REPORT_TOKEN });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/order/${REPORT_TOKEN}/report`);
    await expect(page.getByRole("heading", { name: "Let's make it right" })).toBeVisible();

    const select = page.getByLabel("Problem", { exact: true });
    const qty = page.getByRole("spinbutton").first();
    const note = page.getByLabel(/Anything the store should know/);
    for (const field of [select, qty]) {
      const box = await field.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(48);
      await expect(field).toHaveCSS("font-size", "16px");
    }
    expect((await note.boundingBox())?.height).toBeGreaterThanOrEqual(120);
    const card = (await page.locator(".flow-card", { hasText: "What went wrong?" }).boundingBox())!;
    for (const field of [select, note]) {
      const box = (await field.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width - 16);
    }
    await expect(note).toHaveCSS("font-size", "16px");

    await select.focus();
    await page.keyboard.press("Tab");
    await expect(qty).toBeFocused();
    await expect(qty).not.toHaveCSS("outline-style", "none");
  });

  test("a failed swap answer shows saving and the error inside that item, and the other item stays clear", async ({ page }) => {
    await insertRecoveryOrder({ number: SWAP_ORDER, token: SWAP_TOKEN, substitutions: true });
    const release = await failServerActions(page);
    await page.goto(`${base}/order/${SWAP_TOKEN}/substitutions`);
    const cards = page.locator(".flow-card", { hasText: "is short" });
    await expect(cards).toHaveCount(2);
    const [first, second] = [cards.nth(0), cards.nth(1)];
    await expect(first.getByText(/If you don.t answer, we.ll make the swap/)).toBeVisible();

    await first.getByRole("button", { name: "Refund this item" }).click();
    await expect(first.getByRole("status")).toHaveText(/Saving your choice/);
    release();

    await expect(first.getByRole("alert")).toContainText("We couldn't save your choice");
    await expect(second.getByRole("alert")).toHaveCount(0);
    await expect(first.getByRole("button", { name: "Refund this item" })).toBeEnabled();
  });

  test("a rejected save keeps the values, frees the button and shows the error in the details card", async ({ page, request }) => {
    const email = `e2e-recovery-${Date.now()}@test.example`;
    await insertShopperAccount({ email, password: "E2eTestPass-123!", name: "Rita Recovery" });
    await page.goto(`${base}/account/sign-in`);
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send sign-in link" }).click();
    await expect(page.locator("[data-slot='card-title']")).toContainText("Check your email", { timeout: 10000 });
    const tokenRes = await request.get(`${apiBase}/api/e2e/magic-link-token?email=${encodeURIComponent(email)}`);
    const { token } = await tokenRes.json();
    await page.goto(`${base}/api/auth/magic-link/verify?token=${token}&callbackURL=/account`);
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible({ timeout: 15000 });

    const release = await failServerActions(page);
    release();
    const card = page.locator(".flow-card", { has: page.getByRole("heading", { name: "Personal details" }) });
    await card.getByLabel("Name").fill("Rita Renamed");
    await card.getByLabel("Phone").fill("(301) 555-0199");
    const save = card.getByRole("button", { name: "Save details" });
    await save.click();

    await expect(card.getByRole("alert")).toContainText("We couldn't save your details");
    await expect(save).toBeEnabled();
    await expect(card.getByLabel("Name")).toHaveValue("Rita Renamed");
    await expect(card.getByLabel("Phone")).toHaveValue("(301) 555-0199");
  });
});
