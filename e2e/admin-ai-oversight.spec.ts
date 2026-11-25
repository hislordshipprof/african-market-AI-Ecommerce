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

test("a platform admin reviews AI chats in a two-pane inbox, filters them, moves with J and K, and labels in one click", async ({ page }) => {
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
    // A quiet chat earlier that day: in the sample, listed after the flagged one.
    const quietCart = await tx.cart.create({ data: { storeId: store.id, source: "manual" } });
    const quiet = await tx.aiConversation.create({
      data: {
        storeId: store.id,
        cartId: quietCart.id,
        model: "claude-haiku-5-5",
        createdAt: new Date(`${DAY}T09:00:00.000Z`),
        lastMessageAt: new Date(`${DAY}T09:00:00.000Z`),
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Do you deliver on Sunday?" }] }],
      },
    });
    return { storeId: store.id, cartIds: [cart.id, quietCart.id], conversationId: conversation.id, quietId: quiet.id };
  });
  const chatParam = (id: string) => new RegExp(`chat=shopper%3A${id}`);

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
    await expect(page.getByText("Check what the AI told shoppers and stores, and label its mistakes so they get fixed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Show" })).toHaveCount(0);

    // A day with nothing to review says so and links to the sample size.
    await page.goto("/admin/ai/conversations?day=2001-01-01");
    await expect(page.getByTestId("inbox-empty")).toContainText("Nothing to review");
    await expect(page.getByTestId("inbox-empty").getByRole("link", { name: "Change the sample size" })).toHaveAttribute("href", "/admin/settings/ai-onboarding");

    await page.goto(`/admin/ai/conversations?day=${DAY}&store=${fixture.storeId}`);
    const row = page.getByTestId(`conversation-${fixture.conversationId}`);
    const quietRow = page.getByTestId(`conversation-${fixture.quietId}`);
    await expect(row).toContainText("Price removed");
    await expect(row).toContainText("How much is the egusi?");
    await expect(row).toContainText("Mama Ngozi");
    await expect(row).toContainText("Shopper");
    await expect(quietRow).toContainText("Do you deliver on Sunday?");

    // Filters apply on change, with counts.
    await page.getByText(/^Flagged only/).click();
    await expect(page).toHaveURL(/flagged=1/);
    await expect(quietRow).toHaveCount(0);
    await page.getByText(/^Flagged only/).click();
    await expect(quietRow).toBeVisible();

    await row.click();
    await expect(page).toHaveURL(chatParam(fixture.conversationId));
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#chat-title")).toContainText("Shopper chat");
    const transcript = page.getByTestId("transcript");
    await expect(transcript).toContainText("How much is the egusi? Here is my list.");
    await expect(transcript).toContainText("my-list.jpg");
    await expect(transcript).toContainText("not stored");
    await expect(transcript).toContainText("Tool: search_catalog");
    await expect(page.getByTestId("tool-calls")).toContainText("Price removed");
    expect(await page.locator("img[src^='data:'], img[src*='my-list']").count()).toBe(0);

    await page.keyboard.press("j");
    await expect(page).toHaveURL(chatParam(fixture.quietId));
    await page.keyboard.press("k");
    await expect(page).toHaveURL(chatParam(fixture.conversationId));

    // One click labels, with the note, then the next unlabelled chat opens.
    await page.getByLabel(/Note/).fill("Stated a price before search.");
    await page.getByRole("group", { name: "Label this chat" }).getByRole("button", { name: "Wrong price" }).click();
    await expect(page).toHaveURL(chatParam(fixture.quietId));
    await expect(row).toContainText("Labelled: Wrong price");
    await row.click();
    await expect(page.getByTestId("review-labels")).toContainText("Stated a price before search.");

    // On a phone the list opens the chat full screen, with a Back button.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("h1")).toBeHidden();
    await page.getByRole("link", { name: "Back to the list" }).click();
    await expect(quietRow).toBeVisible();
    await expect(page.getByTestId("transcript")).toBeHidden();

    // Old links to one chat open it in the inbox.
    await page.goto(`/admin/ai/conversations/shopper/${fixture.conversationId}`);
    await expect(page).toHaveURL(chatParam(fixture.conversationId));

    const recorded = await asAdmin(async (tx) => ({
      views: await tx.auditLog.count({ where: { action: "ai_conversation.view", entityId: fixture.conversationId } }),
      flags: await tx.aiReviewFlag.findMany({ where: { aiConversationId: fixture.conversationId } }),
    }));
    expect(recorded.views).toBeGreaterThanOrEqual(1);
    expect(recorded.flags.map((flag) => [flag.storeId, flag.label, flag.note])).toEqual([[fixture.storeId, "wrong_price", "Stated a price before search."]]);
  } finally {
    const ids = [fixture.conversationId, fixture.quietId];
    await asAdmin(async (tx) => {
      await tx.auditLog.deleteMany({ where: { entityId: { in: ids } } });
      await tx.aiReviewFlag.deleteMany({ where: { aiConversationId: { in: ids } } });
    });
    await asAdmin((tx) => tx.$executeRaw`DELETE FROM carts WHERE id = ANY(${fixture.cartIds})`);
  }
});
