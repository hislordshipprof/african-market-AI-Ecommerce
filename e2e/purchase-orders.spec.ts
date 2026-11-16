import { mkdirSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";

const SLUG = "mama-ngozi";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";

function db() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the purchase orders e2e");
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

/** No suppliers or orders, and a saved reorder list of two items. */
async function seed(): Promise<{ first: string; second: string }> {
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
    return { first: listings[0].customName!, second: listings[1].customName! };
  });
}

async function shoot(page: Page, name: string, heading: string) {
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

test("owner adds suppliers, drafts one order per supplier from the reorder list, emails one and opens WhatsApp for the other (#575)", async ({ page }) => {
  const before = await setPlan({ plan: "pro", status: "active" });
  try {
    const items = await seed();
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
    await shoot(page, "575-purchase-orders-drafts", "Orders to wholesalers");

    await lagos.getByLabel(`Quantity of ${items.first}`).fill("15");
    await lagos.getByRole("button", { name: "Send by email" }).click();
    await expect(lagos.getByText("Sent", { exact: true })).toBeVisible();
    await expect(lagos.getByText("15", { exact: true })).toBeVisible();
    await expect(lagos.getByRole("button", { name: "Mark received" })).toBeVisible();

    await accra.getByRole("button", { name: "Send on WhatsApp" }).click();
    await page.waitForURL(/^https:\/\/wa\.me\/12145552368\?text=/);
    const text = new URL(page.url()).searchParams.get("text") ?? "";
    expect(text).toMatch(/^Purchase order \d+ from /);
    expect(text).toContain(`${items.second}: 5`);

    await page.goto(`/store-admin/purchase-orders?store=${SLUG}`);
    await expect(page.getByRole("region", { name: /^Accra Imports · PO \d+$/ }).getByText("Sent", { exact: true })).toBeVisible();
    await page.getByRole("region", { name: /^Lagos Foods · PO \d+$/ }).getByRole("button", { name: "Mark received" }).click();
    await expect(page.getByRole("region", { name: /^Lagos Foods · PO \d+$/ }).getByText("Received", { exact: true })).toBeVisible();
    await shoot(page, "575-purchase-orders-sent", "Orders to wholesalers");

    await setPlan(null);
    await page.goto(`/store-admin/purchase-orders?store=${SLUG}`);
    await expect(page.getByRole("link", { name: "Upgrade to Pro" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add supplier" })).toHaveCount(0);
  } finally {
    await setPlan(before);
  }
});
