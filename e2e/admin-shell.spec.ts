import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { ADMIN_NAV_GROUPS } from "../src/app/admin/(shell)/admin-nav";
import { CLOSED_DISPUTE_STATUSES } from "../src/lib/disputes/status";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

type Tx = import("@prisma/client").Prisma.TransactionClient;

async function asAdmin<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
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
  await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 10000 });
  await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
  await page.click("button[type='submit']");
  await page.waitForURL("**/admin", { timeout: 15000 });
}

const RUN = `e2e859${Date.now()}`;
/** Two stores of this run: one live with an order placed now, one in setup. */
const live = { id: randomUUID(), name: `Shell Live ${RUN}`, slug: `shell-live-${RUN}` };
const setup = { id: randomUUID(), name: `Shell Setup ${RUN}`, slug: `shell-setup-${RUN}` };

test.describe("Platform admin shell, design A (#859)", () => {
  test.beforeAll(async () => {
    await asAdmin(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, timezone, updated_at) VALUES
        (${live.id}, ${live.name}, ${live.slug}, 'active', 'America/New_York', now()),
        (${setup.id}, ${setup.name}, ${setup.slug}, 'setup', 'America/New_York', now())`;
      await tx.$executeRaw`SELECT set_config('app.current_store_id', ${live.id}, true)`;
      const customer = await tx.customer.create({ data: { storeId: live.id, name: "Shell" } });
      // $123.00 of goods, placed now, so it is today in New York.
      await tx.order.create({
        data: {
          storeId: live.id, number: 1, customerId: customer.id, fulfillment: "pickup", status: "COMPLETED",
          subtotalCents: 12300, bufferCents: 0, totalAuthorizedCents: 12300, capturedAmountCents: 12300, platformFeeCents: 0,
        },
      });
    });
  });

  test.afterAll(async () => {
    await asAdmin(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_store_id', ${live.id}, true)`;
      await tx.order.deleteMany({ where: { storeId: live.id } });
      await tx.customer.deleteMany({ where: { storeId: live.id } });
      // Opening the order writes a platform.order_view row.
      await tx.auditLog.deleteMany({ where: { storeId: { in: [live.id, setup.id] } } });
      await tx.store.deleteMany({ where: { id: { in: [live.id, setup.id] } } });
    });
  });

  test.beforeEach(async ({ page }) => {
    await adminSignIn(page);
  });

  test("the menu is grouped under its headings and every page in it opens, on the desktop and in the phone drawer", async ({ page }) => {
    const menu = page.getByRole("navigation", { name: "Admin" });
    for (const group of ADMIN_NAV_GROUPS) {
      if (!group.label) continue;
      const section = menu.locator("div").filter({ has: page.getByRole("heading", { name: group.label, exact: true }) });
      await expect(section.getByRole("link")).toHaveText(group.items.map((item) => new RegExp(`^${item.label}`)));
    }

    for (const group of ADMIN_NAV_GROUPS) {
      const first = group.items[0];
      await menu.getByRole("link", { name: new RegExp(`^${first.label}`) }).click();
      await expect(page).toHaveURL(new RegExp(`${first.href}$`), { timeout: 15000 });
      await expect(menu.locator("[aria-current='page']")).toContainText(first.label);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(menu).toBeHidden();
    await page.getByRole("button", { name: "Menu" }).click();
    await menu.getByRole("link", { name: "AI and onboarding" }).click();
    await expect(page).toHaveURL(/\/admin\/settings\/ai-onboarding$/, { timeout: 15000 });
    await expect(menu).toBeHidden();
  });

  test("⌘K opens the palette; arrows and Enter jump to a page or a store; Esc closes it", async ({ page }) => {
    const palette = page.getByRole("dialog", { name: "Go to" });
    // Retried until the page has hydrated and listens for the shortcut.
    await expect(async () => {
      await page.keyboard.press("ControlOrMeta+k");
      await expect(palette).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
    const input = palette.getByRole("combobox");
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();

    await page.keyboard.press("ControlOrMeta+k");
    await input.fill("courier");
    await expect(palette.getByRole("option")).toHaveText([/Courier incidents/, /Courier settings/]);
    await page.keyboard.press("ArrowDown");
    await expect(palette.getByRole("option", { selected: true })).toContainText("Courier settings");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin\/settings\/couriers$/, { timeout: 15000 });
    await expect(palette).toBeHidden();

    await page.getByRole("button", { name: /Search pages, stores, orders/ }).click();
    await input.fill(`shell live ${RUN}`);
    await expect(palette.getByRole("option", { name: new RegExp(live.name) })).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/admin/stores/${live.id}$`), { timeout: 15000 });

    await page.keyboard.press("ControlOrMeta+k");
    await input.fill(`${live.slug} #1`);
    const order = palette.getByRole("option", { name: /Order #1/ });
    await expect(order).toBeVisible({ timeout: 10000 });
    await order.click();
    await expect(page).toHaveURL(/\/admin\/orders\/search\/[^/]+$/, { timeout: 15000 });
  });

  test("⌘K right after Esc keeps what the admin types in the reopened palette", async ({ page }) => {
    const palette = page.getByRole("dialog", { name: "Go to" });
    await expect(async () => {
      await page.keyboard.press("ControlOrMeta+k");
      await expect(palette).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
    // Close, reopen with ⌘K and type in one task, so the browser's queued close event lands after the typing,
    // as it does when the main thread is busy.
    await page.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>("dialog[aria-label='Go to']")!;
      dialog.close();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true }));
      const input = dialog.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "courier");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("combobox")).toHaveValue("courier");
    await expect(palette.getByRole("option")).toHaveText([/Courier incidents/, /Courier settings/]);
  });

  test("Home shows real counts and today's sales", async ({ page }) => {
    const [stores, active, disputes] = await asAdmin((tx) => Promise.all([
      tx.store.count(),
      tx.store.count({ where: { status: "active" } }),
      tx.paymentDispute.count({ where: { status: { notIn: [...CLOSED_DISPUTE_STATUSES] } } }),
    ]));
    await expect(page.getByTestId("count-stores")).toContainText(`${active} of ${stores}`);
    await expect(page.getByTestId("count-disputes")).toContainText(String(disputes));
    await expect(page.getByRole("region", { name: "Platform health" })).toBeVisible();
    await expect(page.getByText("Demo data")).toHaveCount(0);

    const today = page.getByRole("region", { name: "Stores today" });
    const row = today.getByRole("row", { name: new RegExp(live.name) });
    await expect(row).toContainText("$123");
    await row.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/admin/stores/${live.id}$`), { timeout: 15000 });
  });

  test("Stores tabs count each view, and the filters apply as soon as they change", async ({ page }) => {
    await page.goto("/admin/stores");
    const views = page.getByRole("navigation", { name: "Saved views" });
    const setupCount = await asAdmin((tx) => tx.store.count({ where: { status: "setup" } }));
    await expect(views.getByRole("link", { name: /In setup/ })).toHaveText(`In setup ${setupCount}`);

    await views.getByRole("link", { name: /In setup/ }).click();
    await expect(page).toHaveURL(/view=setup/);
    const table = page.getByRole("table");
    await expect(table.getByRole("link", { name: setup.name })).toBeVisible();
    await expect(table.getByRole("link", { name: live.name })).toHaveCount(0);

    await page.getByRole("link", { name: /^All/ }).click();
    await expect(page).toHaveURL(/\/admin\/stores$/);
    await page.getByRole("searchbox", { name: "Search stores" }).fill(`shell-live-${RUN}`);
    await expect(page).toHaveURL(/q=shell-live/, { timeout: 10000 });
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(page.getByRole("searchbox", { name: "Search stores" })).toBeFocused();

    await page.getByRole("combobox", { name: "Plan" }).selectOption("pro");
    await expect(page).toHaveURL(/plan=pro/);
    await expect(page.getByRole("status")).toHaveText("No store matches these filters.");
    await page.getByRole("link", { name: "Clear" }).click();
    await expect(page).toHaveURL(/\/admin\/stores$/);

    // A click anywhere on the row opens the store.
    // The name link covers the row, so a click on the Status cell lands on it.
    const cell = page.getByRole("row", { name: new RegExp(live.name) }).getByRole("cell").nth(2);
    await cell.scrollIntoViewIfNeeded();
    const box = await cell.boundingBox();
    if (!box) throw new Error("the store row is not on screen");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page).toHaveURL(new RegExp(`/admin/stores/${live.id}$`), { timeout: 15000 });
  });
});
