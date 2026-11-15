import { mkdirSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";

const SLUG = "mama-ngozi";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const KEY = "e2e-549";
const DAY = 86_400_000;

function db() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the stock movement e2e");
  return new PrismaClient({ adapter: new PrismaPg(url) });
}

/** Two counted listings: one selling fast enough to estimate, one below the 3-sale floor. */
async function seed(): Promise<{ fast: string; slow: string }> {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: "owner@mama-ngozi.test" } });
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      await tx.stockEvent.deleteMany({ where: { idempotencyKey: { startsWith: KEY } } });
      const listings = await tx.listing.findMany({
        where: { active: true, stockMode: "counted" },
        orderBy: { id: "asc" },
        take: 2,
        include: { masterProduct: { select: { name: true } } },
      });
      const [fast, slow] = listings;
      if (!fast || !slow) throw new Error("the seed store needs two counted listings");
      await tx.listing.update({ where: { id: fast.id }, data: { qty: 4 } });
      await tx.listing.update({ where: { id: slow.id }, data: { qty: 30 } });
      const at = (days: number) => new Date(Date.now() - days * DAY);
      await tx.stockEvent.createMany({
        data: [
          { listingId: fast.id, type: "sale", delta: -9, createdAt: at(1) },
          { listingId: fast.id, type: "sale", delta: -3, createdAt: at(9) },
          { listingId: fast.id, type: "counter_sale", delta: -2, createdAt: at(2) },
          { listingId: fast.id, type: "restock", delta: 12, createdAt: at(3) },
          { listingId: fast.id, type: "short", delta: -1, createdAt: at(4) },
          { listingId: slow.id, type: "sale", delta: -1, createdAt: at(2) },
        ].map((event, i) => ({ ...event, storeId: store.id, actorId: owner.id, idempotencyKey: `${KEY}-${i}` })),
      });
      return { fast: fast.customName ?? fast.masterProduct?.name ?? "", slow: slow.customName ?? slow.masterProduct?.name ?? "" };
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [["1280px", { width: 1280, height: 900 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      await page.getByRole("heading", { name: "Stock movement" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("copilot page shows stock movement, an estimate in store time, and no guessed date below the floor (#549)", async ({ page }) => {
  const names = await seed();
  await storeOwnerSignIn(page);
  await page.goto(`/store-admin/copilot?store=${SLUG}`);

  const section = page.getByRole("region", { name: "Stock movement" });
  await expect(section).toBeVisible();
  await expect(section.getByText(/Counter sales nobody reports are not seen/)).toBeVisible();

  // 14 units sold in 14 days is 1 a day; 4 on hand is 4 days.
  const fast = section.getByRole("listitem").filter({ hasText: names.fast });
  await expect(fast.getByText("4 on hand")).toBeVisible();
  await expect(fast.getByText("Online 9 (week before 3) · Counter 2 · Restocked 12 · Short 1")).toBeVisible();
  await expect(fast.getByText(/^About 1 a day, 4 days left, est\. out [A-Z][a-z]+day, [A-Z][a-z]{2} \d{1,2}$/)).toBeVisible();

  const slow = section.getByRole("listitem").filter({ hasText: names.slow });
  await expect(slow.getByText("Not enough sales to estimate")).toBeVisible();
  await expect(slow.getByText(/est\. out/)).toHaveCount(0);

  await shoot(page, "549-stock-movement");
});
