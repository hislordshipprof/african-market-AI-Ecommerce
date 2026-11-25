import { mkdirSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";

const SLUG = "mama-ngozi";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const NAME = "E2E Yam 819";

function db() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the copilot drafts e2e");
  return new PrismaClient({ adapter: new PrismaPg(url) });
}

function storeDate(timeZone: string, daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toLocaleDateString("en-CA", { timeZone });
}

/** A chat turn that drafted a coupon, a price change on two sizes and a one-day closure, as the chat leaves them. */
async function seed(): Promise<{ storeId: string; variants: Record<string, string> }> {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: "owner@mama-ngozi.test" } });
    const tomorrow = storeDate(store.timezone, 1);
    const variants: Record<string, string> = {};
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.storeSubscription.upsert({
        where: { storeId: store.id },
        create: { storeId: store.id, plan: "pro", status: "active" },
        update: { plan: "pro", status: "active", overridePlan: null, overrideEndsAt: null },
      });
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      await tx.copilotConversation.deleteMany({ where: { userId: owner.id } });
      await tx.listing.deleteMany({ where: { customName: NAME } });
      const listing = await tx.listing.create({
        data: {
          storeId: store.id, customName: NAME, price: 300, stockMode: "counted", qty: 10,
          variants: { create: [{ label: "1 lb", price: 300, weightG: 450 }, { label: "5 lb", price: 1200, weightG: 2250 }] },
        },
        include: { variants: true },
      });
      for (const v of listing.variants) variants[v.label] = v.id;
      const messageId = crypto.randomUUID();
      const conversation = await tx.copilotConversation.create({
        data: {
          storeId: store.id, userId: owner.id, model: "e2e",
          messages: [
            { role: "owner", text: "10% off over $30 this weekend, raise yams by 50 cents, and we're closed tomorrow" },
            { role: "assistant", text: "I drafted all three. Nothing changes until you confirm.", messageId },
          ],
        },
      });
      const expiresAt = new Date(Date.now() + 24 * 3_600_000);
      const row = (kind: string, payload: object, before: object) => ({
        storeId: store.id, conversationId: conversation.id, clientMessageId: messageId, kind, payload, before, state: "pending", expiresAt,
      });
      const lines = [["1 lb", 300], ["5 lb", 1200]].map(([label, cents]) => ({
        listingId: listing.id, variantId: variants[label as string]!, name: `${NAME} ${label}`, beforeCents: cents as number, afterCents: (cents as number) + 50,
      }));
      await tx.copilotDraft.createMany({
        data: [
          row("coupon", {
            code: "WEEKEND10", kind: "percent", percentOff: "10", amountOff: "", minGoods: "30.00",
            startsAt: "2099-11-28T00:00", endsAt: "2099-11-29T23:59", totalUses: "", usesPerCustomer: "", firstOrderOnly: "",
          }, {}),
          row("price", { lines }, Object.fromEntries(lines.map((line) => [line.variantId, line.beforeCents]))),
          row("store_change", { kind: "day_hours", date: tomorrow, closed: true }, { date: null, weekly: null }),
        ],
      });
    });
    return { storeId: store.id, variants };
  } finally {
    await prisma.$disconnect();
  }
}

async function cleanup() {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      await tx.listing.deleteMany({ where: { customName: NAME } });
      await tx.storeCoupon.deleteMany({ where: { code: "WKND10" } });
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [label, size] of [["1280px", { width: 1280, height: 900 }], ["390px", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await page.getByRole("heading", { name: "Price change" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/${name}-${label}.png`, fullPage: true });
  }
}

test.afterAll(cleanup);

test("the owner confirms chat drafts on cards: an edited coupon, ticked prices only, and a one-day closure that says when it ends (#819)", async ({ page }) => {
  const { storeId, variants } = await seed();
  await storeOwnerSignIn(page);
  await page.goto(`/store-admin/copilot?store=${SLUG}`);

  const waiting = page.getByLabel("Drafts waiting for you");
  await expect(waiting.getByText(/WEEKEND10: 10% off orders of \$30\.00 or more/)).toBeVisible();
  await expect(waiting.getByText(`${NAME} 5 lb`)).toBeVisible();
  await expect(waiting.getByText("$12.00 → $12.50")).toBeVisible();
  await expect(waiting.getByText(/^Closed all day .+ \(one day only\)/)).toBeVisible();
  await expect(waiting.getByText(/^Until the end of /)).toBeVisible();
  await shoot(page, "819-drafts-waiting");

  // Untick the 5 lb line, then confirm one price.
  await waiting.getByLabel(`${NAME} 5 lb`).uncheck();
  await waiting.getByRole("button", { name: "Change 1 price" }).click();
  await expect(page.getByText("Done").first()).toBeVisible();

  await waiting.getByRole("button", { name: "Edit terms" }).click();
  await waiting.getByLabel("Code").fill("WKND10");
  await waiting.getByRole("button", { name: "Create coupon" }).click();
  await expect(page.getByText(/^WKND10: 10% off/)).toBeVisible();

  const prisma = db();
  try {
    const prices = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
      const rows = await tx.listingVariant.findMany({ where: { id: { in: Object.values(variants) } } });
      const coupons = await tx.storeCoupon.count({ where: { code: "WKND10" } });
      return { rows: Object.fromEntries(rows.map((v) => [v.label, v.price])), coupons };
    });
    expect(prices.rows).toEqual({ "1 lb": 350, "5 lb": 1200 });
    expect(prices.coupons).toBe(1);
  } finally {
    await prisma.$disconnect();
  }
  await shoot(page, "819-drafts-confirmed");
});
