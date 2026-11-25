import { mkdirSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeOwnerSignIn } from "./store-owner-auth";

const SLUG = "mama-ngozi";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const NAME = "E2E Egusi 820";
const ORDER_NUMBER = 98201;
const DRAFTED = "Ground egusi melon seeds, 1 lb. Used to thicken egusi soup.";

function db() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL is required for the copilot listing help e2e");
  return new PrismaClient({ adapter: new PrismaPg(url) });
}

type Prisma = ReturnType<typeof db>;
type Tx = Parameters<Parameters<Prisma["$transaction"]>[0]>[0];

async function asStore<T>(prisma: Prisma, storeId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return fn(tx);
  });
}

async function removeOrder(tx: Tx) {
  const ids = (await tx.order.findMany({ where: { number: ORDER_NUMBER }, select: { id: true } })).map((order) => order.id);
  await tx.supportMessage.deleteMany({ where: { thread: { orderId: { in: ids } } } });
  await tx.supportThread.deleteMany({ where: { orderId: { in: ids } } });
  await tx.orderLine.deleteMany({ where: { orderId: { in: ids } } });
  await tx.order.deleteMany({ where: { id: { in: ids } } });
}

/** A chat turn that listed one listing to fix and drafted its description, and an order thread with a customer question. */
async function seed(): Promise<{ storeId: string; listingId: string; threadId: string }> {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: "owner@mama-ngozi.test" } });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.storeSubscription.upsert({
        where: { storeId: store.id },
        create: { storeId: store.id, plan: "pro", status: "active" },
        update: { plan: "pro", status: "active", overridePlan: null, overrideEndsAt: null },
      });
    });
    return await asStore(prisma, store.id, async (tx) => {
      await tx.copilotConversation.deleteMany({ where: { userId: owner.id } });
      await removeOrder(tx);
      await tx.listing.deleteMany({ where: { customName: NAME } });
      const listing = await tx.listing.create({
        data: {
          storeId: store.id, customName: NAME, price: 699, stockMode: "status", status: "in_stock",
          variants: { create: [{ label: "1 lb", price: 699, weightG: 454 }] },
        },
        include: { variants: true },
      });
      const messageId = crypto.randomUUID();
      const conversation = await tx.copilotConversation.create({
        data: {
          storeId: store.id, userId: owner.id, model: "e2e",
          messages: [
            { role: "owner", text: "What needs fixing in my listings? And write a description for E2E Egusi 820" },
            {
              role: "assistant",
              text: "1 listing needs fixing: E2E Egusi 820 has no photo, aisle or description. I drafted a description below.",
              messageId,
              fixes: [{
                listingId: listing.id, name: NAME, missing: ["photo", "aisle", "description"],
                href: `/store-admin/listings?store=${SLUG}&edit=${listing.id}`,
              }],
            },
          ],
        },
      });
      await tx.copilotDraft.create({
        data: {
          storeId: store.id, conversationId: conversation.id, clientMessageId: messageId, kind: "description",
          payload: { listingId: listing.id, name: NAME, text: DRAFTED }, before: { description: null },
          state: "pending", expiresAt: new Date(Date.now() + 24 * 3_600_000),
        },
      });

      const customer = await tx.customer.findFirst({ where: { email: "ada-820@example.com" } })
        ?? await tx.customer.create({ data: { storeId: store.id, name: "Ada", email: "ada-820@example.com" } });
      const order = await tx.order.create({
        data: {
          storeId: store.id, number: ORDER_NUMBER, customerId: customer.id, status: "ACCEPTED", fulfillment: "pickup",
          subtotalCents: 1398, bufferCents: 140, totalAuthorizedCents: 1538, totalCents: 1398, trackingToken: `e2e-820-${Date.now()}`,
        },
      });
      await tx.orderLine.create({
        data: { storeId: store.id, orderId: order.id, listingVariantId: listing.variants[0]!.id, qtyOrdered: 2, unitPriceCents: 699 },
      });
      const thread = await tx.supportThread.create({ data: { storeId: store.id, orderId: order.id, topic: "order" } });
      await tx.supportMessage.create({ data: { storeId: store.id, threadId: thread.id, sender: "customer", body: "Hi, is my order ready yet?" } });
      return { storeId: store.id, listingId: listing.id, threadId: thread.id };
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function cleanup() {
  const prisma = db();
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG } });
    await asStore(prisma, store.id, async (tx) => {
      await removeOrder(tx);
      await tx.listing.deleteMany({ where: { customName: NAME } });
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function shoot(page: Page, name: string, focus?: () => Promise<void>) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [label, size] of [["1280px", { width: 1280, height: 900 }], ["390px", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    if (focus) await focus();
    await page.screenshot({ path: `${SHOTS}/${name}-${label}.png`, fullPage: !focus });
  }
}

// Both tests reseed the same listing and order.
test.describe.configure({ mode: "serial" });
test.afterAll(cleanup);

test("the store chat links each listing to fix to its form, and the owner edits and saves a drafted description (#820)", async ({ page }) => {
  const { storeId, listingId } = await seed();
  await storeOwnerSignIn(page);
  await page.goto(`/store-admin/copilot?store=${SLUG}`);
  // The chat is the Store assistant sheet (#855).
  await page.getByTestId("assistant-launcher").click();
  const sheet = page.getByRole("dialog", { name: "Store assistant" });

  const fixes = sheet.getByRole("region", { name: "Listings to fix" });
  await expect(fixes.getByRole("link", { name: new RegExp(`${NAME}.*No photo, no aisle, no description`) })).toBeVisible();
  const waiting = sheet.getByLabel("Drafts waiting for you");
  await expect(waiting.getByRole("heading", { name: "Product description" })).toBeVisible();
  await expect(waiting.getByLabel("Description shoppers see")).toHaveValue(DRAFTED);
  await shoot(page, "820-chat-fixes-and-description");

  await waiting.getByLabel("Description shoppers see").fill(`${DRAFTED} From Nigeria.`);
  await waiting.getByRole("button", { name: "Save description" }).click();
  await expect(sheet.getByLabel("Settled drafts").getByText("Done")).toBeVisible();
  await expect(sheet.getByText(`${DRAFTED} From Nigeria.`)).toBeVisible();

  const prisma = db();
  try {
    const saved = await asStore(prisma, storeId, (tx) => tx.listing.findUniqueOrThrow({ where: { id: listingId } }));
    expect(saved.description).toBe(`${DRAFTED} From Nigeria.`);
  } finally {
    await prisma.$disconnect();
  }

  // The link opens the listing behind the sheet; its Edit listing dialog takes over, so the sheet steps aside (#855).
  await fixes.getByRole("link", { name: new RegExp(NAME) }).click();
  await expect(page).toHaveURL(/\/store-admin\/listings/);
  await expect(sheet).toBeHidden();
  const dialog = page.getByRole("dialog", { name: "Edit listing" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Description")).toHaveValue(`${DRAFTED} From Nigeria.`);
  await shoot(page, "820-fix-link-opens-edit", async () => {
    await dialog.getByLabel("Description").scrollIntoViewIfNeeded();
  });
});

test("the owner asks for a suggested reply in Messages; it fills the reply box and nothing is sent (#820)", async ({ page }) => {
  const { storeId, threadId } = await seed();
  await storeOwnerSignIn(page);
  await page.goto(`/store-admin/messages?store=${SLUG}&thread=${threadId}`);
  await expect(page.getByText("Hi, is my order ready yet?")).toBeVisible();
  await page.getByRole("button", { name: "Suggest a reply" }).click();
  await expect(page.getByLabel("Reply")).not.toHaveValue("");
  await expect(page.getByText(/Suggested by the store assistant/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Suggest another" })).toBeVisible();
  await shoot(page, "820-messages-suggested-reply");

  const prisma = db();
  try {
    const sent = await asStore(prisma, storeId, (tx) => tx.supportMessage.count({ where: { threadId, sender: "store" } }));
    expect(sent).toBe(0);
  } finally {
    await prisma.$disconnect();
  }
});
