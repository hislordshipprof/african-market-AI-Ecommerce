import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { HANDOFF_PREP_MINUTES, handoffTimezone } from "./handoff-timezone";
import { storeUrl } from "./urls";

const SHOTS = process.env.PROOF_DIR ?? "screenshots";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function asStore<T>(prisma: PrismaClient, storeId: string, run: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return run(tx);
  });
}

/** An agent's tool call to the MCP endpoint of the store host the page is on. */
async function callTool(page: Page, name: string, args: object) {
  return page.evaluate(
    async ({ name, args }) => {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const text = await res.text();
      const data = (res.headers.get("content-type") ?? "").includes("text/event-stream")
        ? text.split("\n").find((line) => line.startsWith("data: "))!.slice(6)
        : text;
      return { status: res.status, result: JSON.parse(data).result as { isError?: boolean; structuredContent?: Record<string, unknown> } };
    },
    { name, args },
  );
}

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [["1280px", { width: 1280, height: 900 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      await page.screenshot({ path: `${SHOTS}/573-${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("an agent's checkout link opens the store's normal checkout once, the shopper pays there, and the order is from an agent (#573)", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const slug = `agent573-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = `Agent Egusi ${slug}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  const store = await prisma.store.create({
    data: {
      slug,
      name: "Agent Market",
      themePreset: "palm-and-shea",
      status: "active",
      aiCatalogReadable: true,
      stripeOnboardingStatus: "complete",
      stripeAccountId: `acct_${slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}`,
      pickupEnabled: true,
      prepTimeMinutes: HANDOFF_PREP_MINUTES,
      timezone: handoffTimezone(new Date()),
      minimumOrderCents: 0,
    },
  });
  const origin = storeUrl(slug);
  try {
    const variantId = await asStore(prisma, store.id, async (tx) => {
      const listing = await tx.listing.create({
        data: { storeId: store.id, customName: name, price: 1200, stockMode: "unlimited", frozen: false, perishable: false },
      });
      return (await tx.listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price: 1200, weightG: 454 } })).id;
    });

    // The agent: no cookies of the shopper, only the store host's MCP endpoint.
    const agentContext = await browser.newContext();
    const agent = await agentContext.newPage();
    await agent.goto(`${origin}/`);
    const { status, result } = await callTool(agent, "create_checkout_link", { items: [{ variant_id: variantId, qty: 2 }] });
    await agentContext.close();
    expect(status).toBe(200);
    expect(result.isError).toBeFalsy();
    const checkoutUrl = result.structuredContent!.checkout_url as string;
    expect(checkoutUrl.startsWith(`${origin}/api/checkout-link/`)).toBe(true);
    expect(await asStore(prisma, store.id, (tx) => tx.order.count())).toBe(0);
    expect((await asStore(prisma, store.id, (tx) => tx.cart.findFirst()))?.paymentIntentId).toBeNull();

    // The shopper opens the link and pays on the normal checkout.
    await page.context().addCookies([{ name: "e2e_stripe_harness", value: "1", url: origin }]);
    await page.goto(checkoutUrl);
    await expect(page).toHaveURL(`${origin}/checkout`);
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
    await shoot(page, "agent-link-checkout");
    await page.getByLabel("Full name").fill("Ada Buyer");
    await page.getByLabel("Phone number (required)").fill("2025550100");
    await page.getByLabel("Email (required)").fill(`ada-${slug}@example.com`);
    const pay = page.getByRole("button", { name: /Place order · .* hold/ });
    await expect(pay).toBeEnabled({ timeout: 15_000 });
    await pay.click();
    await expect(page).toHaveURL(/\/order\/.+placed=1/, { timeout: 20_000 });
    const order = await asStore(prisma, store.id, (tx) => tx.order.findFirst({ include: { lines: true } }));
    expect(order?.acquisitionSource).toBe("agent");
    expect(order?.lines.map((line) => [line.listingVariantId, line.qtyOrdered])).toEqual([[variantId, 2]]);

    // The link worked once: anyone opening it again lands on the expired page.
    const laterContext = await browser.newContext();
    const later = await laterContext.newPage();
    await later.goto(checkoutUrl);
    await expect(later).toHaveURL(`${origin}/checkout/link-expired`);
    await laterContext.close();
  } finally {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.orderLine.deleteMany({ where: { storeId: store.id } });
      await tx.order.deleteMany({ where: { storeId: store.id } });
      await tx.customer.deleteMany({ where: { storeId: store.id } });
      await tx.cart.deleteMany({ where: { storeId: store.id } });
      await tx.listingVariant.deleteMany({ where: { listing: { storeId: store.id } } });
      await tx.listing.deleteMany({ where: { storeId: store.id } });
      await tx.auditLog.deleteMany({ where: { storeId: store.id } });
    });
    await prisma.store.delete({ where: { id: store.id } });
    await prisma.$disconnect();
  }
});
