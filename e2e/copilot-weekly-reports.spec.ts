import { mkdirSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";

const SLUG = "mama-ngozi";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";

function db() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the weekly reports e2e");
  return new PrismaClient({ adapter: new PrismaPg(url) });
}

function figures(from: string, to: string, goodsCents: number) {
  return {
    from,
    to,
    sales: { goodsCents, orders: 14, priorGoodsCents: 41_250, priorOrders: 12, refundsCents: 850 },
    topSellers: [{ name: "Palm oil 1L", units: 18 }, { name: "Egusi 1 lb", units: 11 }, { name: "Gari Ijebu", units: 7 }],
    moversUp: [{ name: "Palm oil 1L", units: 18, priorUnits: 9 }],
    moversDown: [{ name: "Ogbono", units: 2, priorUnits: 8 }],
    runningOutSoon: [{ name: "Palm oil 1L", qty: 4, daysLeft: 2, outDay: "Wednesday" }],
    shorts: [{ name: "Ugu leaves", shortLines: 2, swappedLines: 1 }],
    issues: [{ reason: "Damaged", reports: 1, refundedCents: 850 }],
    cancellations: [{ reason: "Out of stock", orders: 1 }],
    swaps: { answered: 3, timedOut: 1 },
    repeat: { shoppers: 10, repeatShoppers: 4, repeatRatePct: 40 },
  };
}

/** Two sent weeks and one claimed but unsent: only the sent ones show. */
async function seed() {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      await tx.copilotWeeklyReport.deleteMany({ where: { isoWeek: { in: ["2026-W44", "2026-W45", "2026-W46"] } } });
      await tx.copilotWeeklyReport.createMany({
        data: [
          { storeId: store.id, isoWeek: "2026-W44", weekStart: "2026-10-26", figures: figures("2026-10-26", "2026-11-01", 39_900), sentAt: new Date("2026-11-02T14:00:00Z") },
          { storeId: store.id, isoWeek: "2026-W45", weekStart: "2026-11-02", figures: figures("2026-11-02", "2026-11-08", 48_675), sentAt: new Date("2026-11-09T14:00:00Z") },
          { storeId: store.id, isoWeek: "2026-W46", weekStart: "2026-11-09", figures: figures("2026-11-09", "2026-11-15", 1), claimedAt: new Date() },
        ],
      });
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
      await page.getByRole("heading", { name: "Weekly reports" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("copilot page lists the sent weekly reports, newest open first (#550)", async ({ page }) => {
  await seed();
  await storeOwnerSignIn(page);
  await page.goto(`/store-admin/copilot?store=${SLUG}`);

  const section = page.getByRole("region", { name: "Weekly reports" });
  await expect(section).toBeVisible();
  const weeks = section.locator("details > summary");
  await expect(weeks).toHaveCount(2);
  await expect(weeks.nth(0)).toContainText("Nov 2 to Nov 8");
  await expect(weeks.nth(1)).toContainText("Oct 26 to Nov 1");
  await expect(section.getByText("Nov 9 to Nov 15")).toHaveCount(0);

  const latest = section.locator("details").nth(0);
  await expect(latest.getByText("Goods sales: $486.75 from 14 orders (week before: $412.50 from 12 orders)")).toBeVisible();
  await expect(latest.getByText("Palm oil 1L: 4 left, est. out Wednesday")).toBeVisible();
  await expect(latest.getByText("Swap prompts: 3 answered, 1 timed out")).toBeVisible();
  await expect(latest.getByText("Repeat customers: 40% (4 of 10)")).toBeVisible();
  await expect(section.locator("details").nth(1).getByText(/Goods sales: \$399\.00/)).toBeHidden();

  await shoot(page, "550-weekly-reports");
});
