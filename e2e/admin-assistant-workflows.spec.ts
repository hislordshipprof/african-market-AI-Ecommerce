import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type Page } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const METRO_ID = "e2e-metro-833";
const METRO_NAME = "E2E Houston 833";
const STORE_SLUG = "e2e-ade-833";
const STORE_NAME = "E2E Ade's Market 833";
const CATEGORY_ID = "e2e-category-833";
const CATEGORY_NAME = "E2E Grains 833";
const PRODUCTS = { ofada: "e2e-product-833-ofada", jollof: "e2e-product-833-jollof", basmati: "e2e-product-833-basmati" };
const PROOF = process.env.PROOF_DIR;

async function asPlatformAdmin<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
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
  await page.getByLabel("Verification code").waitFor({ state: "visible" });
  await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
  await page.click("button[type='submit']");
  await page.waitForURL("**/admin");
}

async function proof(page: Page, name: string) {
  if (!PROOF) return;
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${PROOF}/833-${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

async function cleanUp() {
  await asPlatformAdmin(async (tx) => {
    const admin = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
    if (admin[0]) await tx.adminAssistantConversation.deleteMany({ where: { userId: admin[0].id } });
    const store = await tx.store.findUnique({ where: { slug: STORE_SLUG }, select: { id: true } });
    if (store) {
      await tx.storeInvite.deleteMany({ where: { storeId: store.id } });
      await tx.storeSubscription.deleteMany({ where: { storeId: store.id } });
      await tx.auditLog.deleteMany({ where: { storeId: store.id } });
      await tx.store.delete({ where: { id: store.id } });
    }
    await tx.metro.deleteMany({ where: { id: METRO_ID } });
    await tx.masterProduct.deleteMany({ where: { id: { in: Object.values(PRODUCTS) } } });
    await tx.category.deleteMany({ where: { id: CATEGORY_ID } });
  });
}

// Both tests share the fixtures, so they run one after the other.
test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  await cleanUp();
  await asPlatformAdmin(async (tx) => {
    await tx.metro.create({ data: { id: METRO_ID, name: METRO_NAME, states: ["TX"], centerLat: 29.76, centerLng: -95.37, radiusMi: 40 } });
    await tx.category.create({ data: { id: CATEGORY_ID, name: CATEGORY_NAME, slug: CATEGORY_ID, sortOrder: 990 } });
    const product = (id: string, name: string, imageUrl: string | null) => tx.masterProduct.create({
      data: { id, name, categoryId: CATEGORY_ID, status: "needs_review", description: `${name}, 5 lb bag.`, unit: "5 lb", confidence: "high", imageUrl },
    });
    await product(PRODUCTS.ofada, "E2E Ofada rice 833", "/products/rice.webp");
    await product(PRODUCTS.jollof, "E2E Jollof rice mix 833", "/products/rice.webp");
    await product(PRODUCTS.basmati, "E2E Basmati rice 833", null);
  });
});

test.afterEach(cleanUp);

test("an admin creates a store by asking: the assistant asks for what is missing, then one card runs every step (#833)", async ({ page }) => {
  await adminSignIn(page);
  await page.goto("/admin/assistant");
  const conversation = page.getByRole("region", { name: "Conversation" });

  await send(page, "Create a store for Ade's Market in Houston");
  await expect(conversation.getByText("To create the store I still need the slug", { exact: false })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);

  await send(page, `Create a store: name=${STORE_NAME}; slug=${STORE_SLUG}; addressLine1=3700 Main St; city=Houston; state=TX; zip=77002; ownerEmail=ade-833@example.test; metro=${METRO_NAME}`);
  const card = page.getByRole("article", { name: "Create a store" });
  await expect(card).toBeVisible();
  const steps = card.getByRole("list").first().getByRole("listitem");
  await expect(steps).toHaveText(["Create the store", `Put it in the ${METRO_NAME} metro`, "Invite the owner, ade-833@example.test"]);
  expect(await asPlatformAdmin((tx) => tx.store.count({ where: { slug: STORE_SLUG } }))).toBe(0);
  await proof(page, "store-card");

  await card.getByRole("button", { name: "Confirm" }).click();
  await expect(card.getByText("Done: the store was created, it is in its metro, the owner invite went to ade-833@example.test.")).toBeVisible();
  const store = await asPlatformAdmin((tx) => tx.store.findUniqueOrThrow({ where: { slug: STORE_SLUG }, select: { name: true, metroId: true, status: true } }));
  expect(store).toEqual({ name: STORE_NAME, metroId: METRO_ID, status: "setup" });
  await proof(page, "store-confirmed");
});

test("an admin approves a review-queue batch, sees each product's problems and unticks one (#833)", async ({ page }) => {
  await adminSignIn(page);
  await page.goto("/admin/assistant");

  await send(page, `Approve the clean products in the review queue for ${CATEGORY_NAME}`);
  const card = page.getByRole("article", { name: "Approve products in the review queue" });
  await expect(card).toBeVisible();
  await expect(card.getByText("3 of 3 ticked", { exact: false })).toBeVisible();
  await expect(card.getByText("no photo")).toBeVisible();
  await card.getByRole("checkbox", { name: /E2E Basmati rice 833/ }).uncheck();
  await expect(card.getByText("2 of 3 ticked", { exact: false })).toBeVisible();
  await proof(page, "batch-card");

  await card.getByRole("button", { name: "Confirm" }).click();
  await expect(card.getByText("Done 2 of 2.")).toBeVisible();
  const statuses = await asPlatformAdmin((tx) => tx.masterProduct.findMany({ where: { id: { in: Object.values(PRODUCTS) } }, select: { id: true, status: true } }));
  expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
    [PRODUCTS.ofada]: "active", [PRODUCTS.jollof]: "active", [PRODUCTS.basmati]: "needs_review",
  });
  await proof(page, "batch-confirmed");
});
