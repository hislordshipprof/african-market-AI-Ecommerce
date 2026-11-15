import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";
import { storeUrl } from "./urls";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const PATH = "/admin/ai/eval-spend";

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

type Run = { model: string; finishedAt: string; summary: { hallucinatedItems: number } };
const report = JSON.parse(readFileSync(resolve(__dirname, "../src/lib/assistant/eval/report.json"), "utf8")) as {
  runs: Run[];
  average: { microPrecision: number; microRecall: number };
};

test("unauthenticated access to the eval and spend page redirects to sign-in", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${storeUrl()}${PATH}`);
  await expect(page).toHaveURL(/\/admin\/sign-in/, { timeout: 10000 });
  await context.close();
});

test("a platform admin sees the committed eval, the spend cap and stores near their chat cap", async ({ page }) => {
  const month = new Date(`${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`);
  const suffix = randomUUID().slice(0, 8);
  const ids = await asAdmin(async (tx) => {
    const near = await tx.store.create({ data: { slug: `e2e-near-${suffix}`, name: `Near Cap Market ${suffix}`, themePreset: "palm-and-shea" } });
    const pro = await tx.store.create({ data: { slug: `e2e-pro-${suffix}`, name: `Pro Chat Market ${suffix}`, themePreset: "palm-and-shea" } });
    await tx.storeSubscription.create({ data: { storeId: pro.id, plan: "pro", status: "active" } });
    await tx.assistantChatMonth.create({ data: { storeId: near.id, month, chats: 850 } });
    await tx.assistantChatMonth.create({ data: { storeId: pro.id, month, chats: 850 } });
    return { near: near.id, pro: pro.id };
  });

  try {
    await adminSignIn(page);
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "AI eval and spend" }).click();
    await expect(page.locator("h1")).toHaveText("AI eval and spend", { timeout: 15000 });

    await expect(page.getByTestId("eval-model")).toHaveText(report.runs[0]!.model);
    const finished = report.runs.map((run) => run.finishedAt).sort().at(-1)!;
    await expect(page.getByTestId("eval-date").locator("time")).toHaveAttribute("datetime", finished);
    await expect(page.getByTestId("eval-table").locator("thead th")).toHaveText(["Measure", "Run 1", "Run 2", "Result"]);
    await expect(page.getByTestId("eval-precision").locator("td").last()).toHaveText(`${(report.average.microPrecision * 100).toFixed(1)}%`);
    await expect(page.getByTestId("eval-recall").locator("td").last()).toHaveText(`${(report.average.microRecall * 100).toFixed(1)}%`);
    const madeUp = report.runs.reduce((sum, run) => sum + run.summary.hallucinatedItems, 0);
    await expect(page.getByTestId("eval-made-up").locator("td").last()).toHaveText(String(madeUp));
    await expect(page.getByTestId("eval-dish").locator("td")).toHaveCount(3);
    await expect(page.getByTestId("eval-verdict").locator("td").last()).toHaveText(/Haiku OK|Sonnet candidate/);
    await expect(page.getByTestId("eval-cost").locator("td").last()).toHaveText(/^\$\d+\.\d{2}$/);

    await expect(page.getByTestId("assistant-state")).toHaveText(/^The shopping assistant is (on|resting): .+ spent of the \$[\d,]+\.\d{2} cap\.$/);
    await expect(page.getByRole("meter", { name: "Spend against the cap" })).toBeVisible();

    const near = page.getByTestId(`chats-${ids.near}`);
    await expect(near).toContainText("850 of 1,000");
    await expect(near.getByTestId("near-cap")).toHaveText("80% or more");
    const pro = page.getByTestId(`chats-${ids.pro}`);
    await expect(pro).toContainText("850 of 5,000");
    await expect(pro.getByTestId("near-cap")).toHaveCount(0);
  } finally {
    await asAdmin(async (tx) => {
      await tx.assistantChatMonth.deleteMany({ where: { storeId: { in: [ids.near, ids.pro] } } });
      await tx.storeSubscription.deleteMany({ where: { storeId: { in: [ids.near, ids.pro] } } });
      await tx.store.deleteMany({ where: { id: { in: [ids.near, ids.pro] } } });
    });
  }
});
