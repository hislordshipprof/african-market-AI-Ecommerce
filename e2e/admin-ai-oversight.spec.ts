import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const DAY = "2001-04-05";

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

test("a platform admin reviews a flagged shopper chat, sees no file content, and labels it", async ({ page }) => {
  const fixture = await asAdmin(async (tx) => {
    const store = await tx.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } });
    const cart = await tx.cart.create({ data: { storeId: store.id, source: "manual" } });
    const at = new Date(`${DAY}T15:30:00.000Z`);
    const conversation = await tx.aiConversation.create({
      data: {
        storeId: store.id,
        cartId: cart.id,
        model: "claude-haiku-5-5",
        createdAt: at,
        lastMessageAt: at,
        messages: [
          {
            id: "u1",
            role: "user",
            parts: [
              { type: "text", text: "How much is the egusi? Here is my list." },
              { type: "data-attachment", data: { name: "my-list.jpg", mediaType: "image/jpeg", bytes: 48_000, digest: "e2e-digest" } },
            ],
          },
          {
            id: "a1",
            role: "assistant",
            parts: [
              { type: "tool-search_catalog", toolCallId: "c1", state: "output-available", input: { query: "egusi" }, output: { ok: true, items: [] } },
              { type: "text", text: "I couldn't confirm that price." },
            ],
          },
        ],
      },
    });
    await tx.aiAction.create({
      data: { storeId: store.id, conversationId: conversation.id, tool: "grounding_strip", input: { amount: "$4.00" }, output: {}, ok: true, createdAt: at },
    });
    return { storeId: store.id, cartId: cart.id, conversationId: conversation.id };
  });

  try {
    await page.goto("/admin/sign-in");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.click("button[type='submit']");
    await page.getByLabel("Verification code").waitFor({ state: "visible" });
    await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
    await page.click("button[type='submit']");
    await page.waitForURL("**/admin");

    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "AI conversations" }).first().click();
    await expect(page.locator("h1")).toHaveText("AI conversations");

    await page.goto(`/admin/ai/conversations?day=${DAY}&store=${fixture.storeId}`);
    const row = page.getByTestId(`conversation-${fixture.conversationId}`);
    await expect(row).toContainText("Price removed");
    await expect(row).toContainText("In sample");
    await row.click();

    await expect(page.locator("h1")).toContainText("Shopper chat");
    const transcript = page.getByTestId("transcript");
    await expect(transcript).toContainText("How much is the egusi? Here is my list.");
    await expect(transcript).toContainText("my-list.jpg");
    await expect(transcript).toContainText("not stored");
    await expect(transcript).toContainText("Tool: search_catalog");
    await expect(page.getByTestId("tool-calls")).toContainText("Price removed");
    expect(await page.locator("img[src^='data:'], img[src*='my-list']").count()).toBe(0);

    await page.getByRole("radio", { name: "Wrong price" }).check();
    await page.getByLabel(/Note/).fill("Stated a price before search.");
    await page.getByRole("button", { name: "Save label" }).click();
    await expect(page.getByTestId("review-labels")).toContainText("Wrong price");
    await expect(page.getByTestId("review-labels")).toContainText("Stated a price before search.");

    const recorded = await asAdmin(async (tx) => ({
      views: await tx.auditLog.count({ where: { action: "ai_conversation.view", entityId: fixture.conversationId } }),
      flags: await tx.aiReviewFlag.findMany({ where: { aiConversationId: fixture.conversationId } }),
    }));
    expect(recorded.views).toBeGreaterThanOrEqual(1);
    expect(recorded.flags.map((flag) => [flag.storeId, flag.label])).toEqual([[fixture.storeId, "wrong_price"]]);
  } finally {
    await asAdmin(async (tx) => {
      await tx.auditLog.deleteMany({ where: { entityId: fixture.conversationId } });
      await tx.aiReviewFlag.deleteMany({ where: { aiConversationId: fixture.conversationId } });
    });
    await asAdmin((tx) => tx.$executeRaw`DELETE FROM carts WHERE id = ${fixture.cartId}`);
  }
});
