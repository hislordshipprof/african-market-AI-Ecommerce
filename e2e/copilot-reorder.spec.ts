import { mkdirSync, readFileSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";

const SLUG = "mama-ngozi";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const KEY = "e2e-551";
const DAY = 86_400_000;

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
