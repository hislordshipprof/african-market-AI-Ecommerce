import { mkdirSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";

const SLUG = "mama-ngozi";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const CODE = `E2E-${Date.now().toString().slice(-8)}`;

function db() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the promotions e2e");
  return new PrismaClient({ adapter: new PrismaPg(url) });
}

async function asStore<T>(fn: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0], storeId: string) => Promise<T>): Promise<T> {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      return fn(tx, store.id);
    });
  } finally {
    await prisma.$disconnect();
  }
}

/** One completed order that used the code, as checkout (#557) will record it. */
async function useCode(): Promise<void> {
  await asStore(async (tx, storeId) => {
    const coupon = await tx.storeCoupon.findUniqueOrThrow({ where: { storeId_code: { storeId, code: CODE } } });
    const customer = await tx.customer.create({ data: { storeId, name: `Promo shopper ${CODE}` } });
    const last = await tx.order.findFirst({ orderBy: { number: "desc" }, select: { number: true } });
    await tx.order.create({
      data: {
        storeId, number: (last?.number ?? 0) + 1, customerId: customer.id, status: "COMPLETED",
        subtotalCents: 4000, bufferCents: 0, totalAuthorizedCents: 3600, totalCents: 3600, couponId: coupon.id, discountCents: 400,
      },
    });
  });
}

async function cleanUp(): Promise<void> {
  await asStore(async (tx) => {
    const coupons = await tx.storeCoupon.findMany({ where: { code: { startsWith: "E2E-" } }, select: { id: true } });
    const ids = coupons.map((c) => c.id);
    const orders = await tx.order.findMany({ where: { couponId: { in: ids } }, select: { customerId: true } });
    await tx.order.deleteMany({ where: { couponId: { in: ids } } });
    await tx.customer.deleteMany({ where: { id: { in: orders.map((o) => o.customerId) } } });
    await tx.storeCoupon.deleteMany({ where: { id: { in: ids } } });
  });
}

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [["1280px", { width: 1280, height: 900 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      // Colours ease between themes; shoot once they settle.
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.afterAll(cleanUp);

test("owner creates a code, sees its uses and discount, cannot change a used code's value, and deactivates it (#556)", async ({ page }) => {
  await cleanUp();
  await storeOwnerSignIn(page);
  await page.goto(`/store-admin?store=${SLUG}`);
  await page.getByRole("link", { name: /Promotions/ }).click();
  await expect(page.getByRole("heading", { name: "Promotions" })).toBeVisible();

  await page.getByRole("button", { name: "New code" }).click();
  const form = page.getByRole("form", { name: "New code" });
  await shoot(page, "promotions-new");
  await form.getByLabel("Code").fill(CODE.toLowerCase());
  await form.getByLabel("Percent (1 to 90)").fill("10");
  await form.getByLabel("Minimum goods ($)").fill("25");
  await form.getByLabel("Total uses").fill("50");
  await form.getByRole("button", { name: "Create code" }).click();

  const row = page.getByRole("listitem").filter({ hasText: CODE });
  await expect(row).toBeVisible();
  await expect(row.getByText("10% off")).toBeVisible();
  await expect(row.getByText("Goods over $25.00 · 1 per customer")).toBeVisible();
  await expect(row.getByText("0 of 50")).toBeVisible();

  // The same code twice, in another case, is refused.
  await page.getByRole("button", { name: "New code" }).click();
  await form.getByLabel("Code").fill(CODE);
  await form.getByLabel("Percent (1 to 90)").fill("15");
  await form.getByRole("button", { name: "Create code" }).click();
  await expect(form.getByRole("alert")).toHaveText(`Your store already has the code ${CODE}.`);
  await form.getByRole("button", { name: "Cancel" }).click();

  await useCode();
  await page.reload();
  await expect(row.getByText("1 of 50")).toBeVisible();
  await expect(row.getByText("$4.00")).toBeVisible();

  await row.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("form", { name: `Edit ${CODE}` });
  await expect(edit.getByLabel("Percent (1 to 90)")).toBeDisabled();
  await expect(edit.getByText(/has been used, so its type and value are fixed/)).toBeVisible();
  await shoot(page, "promotions-list");
  await edit.getByLabel("Total uses").fill("80");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(row.getByText("1 of 80")).toBeVisible();

  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(row.getByText("Inactive")).toBeVisible();
  await expect(row.getByRole("button", { name: "Activate" })).toBeVisible();
});
