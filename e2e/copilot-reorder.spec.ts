import { mkdirSync, readFileSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";

const SLUG = "mama-ngozi";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const KEY = "e2e-551";
const DAY = 86_400_000;

// Both tests rewrite mama-ngozi's reorder list, so they run one after the other (#575).
test.describe.configure({ mode: "serial" });

function db() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the reorder e2e");
  return new PrismaClient({ adapter: new PrismaPg(url) });
}

async function asPlatformAdmin<T>(fn: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
  const prisma = db();
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return fn(tx);
    });
  } finally {
    await prisma.$disconnect();
  }
}

type Billing = { plan: string; status: string } | null;

async function setPlan(row: Billing): Promise<Billing> {
  return asPlatformAdmin(async (tx) => {
    const store = await tx.store.findUniqueOrThrow({ where: { slug: SLUG } });
    const before = await tx.storeSubscription.findUnique({ where: { storeId: store.id }, select: { plan: true, status: true } });
    if (row) {
      await tx.storeSubscription.upsert({ where: { storeId: store.id }, create: { storeId: store.id, ...row }, update: row });
    } else {
      await tx.storeSubscription.deleteMany({ where: { storeId: store.id } });
    }
    return before;
  });
}

/** One counted listing selling 1 a day with 2 on hand, and one status listing marked low that sold. */
async function seed(): Promise<{ counted: string; status: string }> {
  return asPlatformAdmin(async (tx) => {
    const store = await tx.store.findUniqueOrThrow({ where: { slug: SLUG } });
    const owner = await tx.user.findUniqueOrThrow({ where: { email: "owner@mama-ngozi.test" } });
    await tx.stockEvent.deleteMany({ where: { storeId: store.id, idempotencyKey: { startsWith: KEY } } });
    await tx.reorderList.deleteMany({ where: { storeId: store.id } });
    const counted = await tx.listing.findFirst({
      where: { storeId: store.id, active: true, stockMode: "counted" },
      orderBy: { id: "desc" },
      include: { masterProduct: { select: { name: true } } },
    });
    const status = await tx.listing.findFirst({
      where: { storeId: store.id, active: true, stockMode: "status" },
      orderBy: { id: "desc" },
      include: { masterProduct: { select: { name: true } } },
    });
    if (!counted || !status) throw new Error("the seed store needs a counted and a status listing");
    await tx.listing.update({ where: { id: counted.id }, data: { qty: 2 } });
    await tx.listing.update({ where: { id: status.id }, data: { status: "low" } });
    await tx.stockEvent.createMany({
      data: [
        { listingId: counted.id, type: "sale", delta: -28, createdAt: new Date(Date.now() - 2 * DAY) },
        { listingId: status.id, type: "counter_sale", delta: -1, createdAt: new Date(Date.now() - 3 * DAY) },
      ].map((event, i) => ({ ...event, storeId: store.id, actorId: owner.id, idempotencyKey: `${KEY}-${i}` })),
    });
    return {
      counted: counted.customName ?? counted.masterProduct?.name ?? "",
      status: status.customName ?? status.masterProduct?.name ?? "",
    };
  });
}

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Buttons use transition-all; let the scheme change finish before the shot.
    await page.waitForTimeout(400);
    for (const [label, size] of [["1280px", { width: 1280, height: 900 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      await page.getByRole("heading", { name: "Reorder suggestions" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${name}-${scheme}-${label}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("owner edits and saves a reorder list, then downloads, prints and copies it; Starter sees it locked (#551)", async ({ page, context }) => {
  const before = await setPlan({ plan: "pro", status: "active" });
  try {
    const names = await seed();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/copilot?store=${SLUG}`);

    const section = page.getByRole("region", { name: "Reorder suggestions" });
    await expect(section.getByText(/Enough to last 7 days until the delivery arrives and 14 days after/)).toBeVisible();
    await expect(section.getByLabel("Lead time (days)")).toHaveValue("7");
    await expect(section.getByLabel("Cover (days)")).toHaveValue("14");

    const counted = section.getByRole("listitem").filter({ hasText: names.counted });
    await expect(counted.getByText(/^2 on hand · \d+ sold in 28 days/)).toBeVisible();
    const suggestedText = await counted.getByText(/^Suggested \d+$/).textContent();
    // At least the seeded 28 sales: 1 a day x 21 days, less 2 on hand.
    expect(Number(suggestedText?.replace("Suggested ", ""))).toBeGreaterThanOrEqual(19);
    const status = section.getByRole("listitem").filter({ hasText: names.status });
    await expect(status.getByText(/Marked low, \d+ sold in 28 days\. Counts not tracked\./)).toBeVisible();
    await expect(status.getByLabel(`Order quantity for ${names.status}`)).toHaveAttribute("placeholder", "No count");
    await shoot(page, "551-reorder-suggestions");

    await counted.getByLabel(`Order quantity for ${names.counted}`).fill("7");
    await section.getByRole("button", { name: "Save reorder list" }).click();
    const saved = section.getByRole("region", { name: "Saved reorder list" });
    await expect(saved.getByRole("listitem").filter({ hasText: names.counted }).getByText("7", { exact: true })).toBeVisible();
    await expect(saved.getByRole("listitem").filter({ hasText: names.status }).getByText("Reorder (no count)")).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent("download"), saved.getByRole("link", { name: "Download CSV" }).click()]);
    const csv = readFileSync((await download.path())!, "utf8");
    expect(csv.startsWith("Item,Quantity\r\n")).toBe(true);
    expect(csv).toContain(`,7\r\n`);
    expect(csv).toContain(",reorder (no count)\r\n");

    await saved.getByRole("button", { name: "Copy as text" }).click();
    await expect(saved.getByText("Copied.")).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain(`${names.counted}: 7`);
    expect(text).toContain(`${names.status}: reorder (no count)`);

    await shoot(page, "551-reorder-saved");

    await saved.getByRole("link", { name: "Print" }).click();
    await expect(page.getByRole("heading", { name: /^Reorder list for / })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: names.counted }).getByRole("cell", { name: "7", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("button", { name: "Print" })).toBeHidden();
    await page.emulateMedia({ media: "screen" });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      for (const [label, width] of [["1280px", 1280], ["390px", 390]] as const) {
        await page.setViewportSize({ width, height: 844 });
        await page.screenshot({ path: `${SHOTS}/551-reorder-print-${scheme}-${label}.png` });
      }
    }
    await page.emulateMedia({ colorScheme: "light" });

    await setPlan(null);
    await page.goto(`/store-admin/copilot?store=${SLUG}`);
    const locked = page.getByRole("region", { name: "Reorder suggestions" });
    await expect(locked.getByRole("link", { name: "Upgrade to Pro" })).toBeVisible();
    await expect(locked.getByRole("button", { name: "Save reorder list" })).toHaveCount(0);
    await shoot(page, "551-reorder-locked");
  } finally {
    await setPlan(before);
  }
});

/** No suppliers or orders, and a saved reorder list of two items. */
async function seedOrders(): Promise<{ first: string; second: string; firstId: string }> {
  return asPlatformAdmin(async (tx) => {
    const store = await tx.store.findUniqueOrThrow({ where: { slug: SLUG } });
    const owner = await tx.user.findUniqueOrThrow({ where: { email: "owner@mama-ngozi.test" } });
    await tx.purchaseOrder.deleteMany({ where: { storeId: store.id } });
    await tx.supplier.deleteMany({ where: { storeId: store.id } });
    await tx.reorderList.deleteMany({ where: { storeId: store.id } });
    const listings = await tx.listing.findMany({
      where: { storeId: store.id, active: true, customName: { not: null } },
      orderBy: { customName: "asc" },
      take: 2,
    });
    if (listings.length < 2) throw new Error("the seed store needs two named listings");
    const list = await tx.reorderList.create({ data: { storeId: store.id, savedById: owner.id } });
    await tx.reorderListItem.createMany({
      data: listings.map((listing, position) => ({
        listId: list.id,
        storeId: store.id,
        listingId: listing.id,
        name: listing.customName!,
        quantity: position === 0 ? 12 : 5,
        position,
      })),
    });
    return { first: listings[0].customName!, second: listings[1].customName!, firstId: listings[0].id };
  });
}

async function shootPage(page: Page, name: string, heading: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    for (const [label, size] of [["1280px", { width: 1280, height: 900 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      await page.getByRole("heading", { name: heading }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function addSupplier(page: Page, input: { name: string; channel: string; phone?: string; email?: string }) {
  await page.getByRole("button", { name: "Add supplier" }).click();
  await page.getByLabel("Business name", { exact: true }).fill(input.name);
  if (input.phone) await page.getByLabel("Phone", { exact: true }).fill(input.phone);
  if (input.email) await page.getByLabel("Email", { exact: true }).fill(input.email);
  await page.getByLabel("Send orders by").selectOption(input.channel);
  await page.getByRole("button", { name: "Add supplier" }).click();
  await expect(page.getByRole("region", { name: input.name })).toBeVisible();
}

async function pickItem(page: Page, supplier: string, item: string) {
  const card = page.getByRole("region", { name: supplier });
  await card.getByRole("button", { name: "Items" }).click();
  await card.getByRole("searchbox").fill(item);
  await card.getByRole("checkbox").first().check();
  await card.getByRole("button", { name: /^Save 1 item$/ }).click();
  await expect(card.getByText("Items saved.")).toBeVisible();
}

test("owner adds suppliers, drafts one order per supplier from the reorder list, emails one and opens WhatsApp for the other (#575), then receives a short delivery into stock (#576)", async ({ page }) => {
  const before = await setPlan({ plan: "pro", status: "active" });
  try {
    const items = await seedOrders();
    await page.route("https://wa.me/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp</title>" }));
    await storeOwnerSignIn(page);
    await page.goto(`/store-admin/purchase-orders?store=${SLUG}`);
    await expect(page.getByText("No purchase orders yet.")).toBeVisible();

    await addSupplier(page, { name: "Lagos Foods", channel: "email", email: "delivered@resend.dev" });
    await addSupplier(page, { name: "Accra Imports", channel: "whatsapp", phone: "(214) 555-2368" });
    await pickItem(page, "Lagos Foods", items.first);
    await pickItem(page, "Accra Imports", items.second);

    await page.getByRole("button", { name: "Draft orders from reorder list" }).click();
    await expect(page.getByText("2 draft orders ready. Check them, then send.")).toBeVisible();
    const lagos = page.getByRole("region", { name: /^Lagos Foods · PO \d+$/ });
    const accra = page.getByRole("region", { name: /^Accra Imports · PO \d+$/ });
    await expect(lagos.getByLabel(`Quantity of ${items.first}`)).toHaveValue("12");
    await expect(accra.getByLabel(`Quantity of ${items.second}`)).toHaveValue("5");
    await shootPage(page, "575-purchase-orders-drafts", "Orders to wholesalers");

    await lagos.getByLabel(`Quantity of ${items.first}`).fill("15");
    await lagos.getByRole("button", { name: "Send by email" }).click();
    await expect(lagos.getByText("Sent", { exact: true })).toBeVisible();
    await expect(lagos.getByText("15", { exact: true })).toBeVisible();
    await expect(lagos.getByRole("button", { name: "Receive delivery" })).toBeVisible();

    await accra.getByRole("button", { name: "Send on WhatsApp" }).click();
    await page.waitForURL(/^https:\/\/wa\.me\/12145552368\?text=/);
    const text = new URL(page.url()).searchParams.get("text") ?? "";
    expect(text).toMatch(/^Purchase order \d+ from /);
    expect(text).toContain(`${items.second}: 5`);

    await page.goto(`/store-admin/purchase-orders?store=${SLUG}`);
    await expect(page.getByRole("region", { name: /^Accra Imports · PO \d+$/ }).getByText("Sent", { exact: true })).toBeVisible();
    await shootPage(page, "575-purchase-orders-sent", "Orders to wholesalers");

    // #576: 10 of the 15 ordered came. One tap adds them to stock and receives the order.
    const stockOf = () => asPlatformAdmin((tx) => tx.listing.findUniqueOrThrow({ where: { id: items.firstId }, select: { qty: true, stockMode: true } }));
    const stockBefore = await stockOf();
    const received = page.getByRole("region", { name: /^Lagos Foods · PO \d+$/ });
    await received.getByRole("button", { name: "Receive delivery" }).click();
    const qty = received.getByLabel(`Quantity of ${items.first} received`);
    expect(stockBefore.stockMode).toBe("counted");
    await expect(qty).toHaveValue("15");
    await qty.fill("10");
    await shootPage(page, "576-receive-form", "Orders to wholesalers");
    await received.getByRole("button", { name: "Add 1 item to stock" }).click();
    await expect(received.getByText("1 item added to stock.")).toBeVisible();
    await expect(received.getByText("Received", { exact: true })).toBeVisible();
    await expect(received.getByRole("button", { name: "Receive delivery" })).toHaveCount(0);
    const stockAfter = await stockOf();
    expect(stockAfter.qty).toBe((stockBefore.qty ?? 0) + 10);
    const events = await asPlatformAdmin((tx) => tx.stockEvent.count({ where: { listingId: items.firstId, idempotencyKey: { startsWith: "po-receipt:" } } }));
    expect(events).toBe(1);
    await page.reload();
    await expect(page.getByRole("region", { name: /^Lagos Foods · PO \d+$/ }).getByText("Came in: 10")).toBeVisible();
    await shootPage(page, "576-received", "Orders to wholesalers");

    await setPlan(null);
    await page.goto(`/store-admin/purchase-orders?store=${SLUG}`);
    await expect(page.getByRole("link", { name: "Upgrade to Pro" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add supplier" })).toHaveCount(0);
  } finally {
    await setPlan(before);
  }
});
