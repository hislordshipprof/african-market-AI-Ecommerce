import { mkdirSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { laneSmokePort, reservePort, startSpawnedServer } from "./spawned-server";
import { storeOwnerSignIn } from "./store-owner-auth";

// Both seeded stores' switch is changed here, so nothing else may run alongside.
test.describe.configure({ mode: "serial" });

const SHOTS = process.env.PROOF_DIR ?? "screenshots";

/** Writes the switch straight to the database, then expires the server's cached store row (5 minutes, kept on disk). */
async function setReadable(server: string, slug: string, aiCatalogReadable: boolean): Promise<void> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
  let id: string;
  try {
    id = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return (await tx.store.update({ where: { slug }, data: { aiCatalogReadable }, select: { id: true } })).id;
    });
  } finally {
    await prisma.$disconnect();
  }
  const res = await fetch(`${server}/api/storefront/revalidate`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.STOREFRONT_REVALIDATION_SECRET ?? "e2e-storefront-revalidate"}`, "content-type": "application/json" },
    body: JSON.stringify({ stores: [{ id, slug }] }),
  });
  expect(res.status).toBe(200);
}

/** An agent's JSON-RPC call to the MCP endpoint of the host the page is on. */
async function mcp(page: Page, method: string, params?: object): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return page.evaluate(
    async ({ method, params }) => {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
      });
      const text = await res.text();
      if (res.status !== 200) return { status: res.status, body: null };
      const data = (res.headers.get("content-type") ?? "").includes("text/event-stream")
        ? text.split("\n").find((line) => line.startsWith("data: "))!.slice(6)
        : text;
      return { status: res.status, body: JSON.parse(data) };
    },
    { method, params },
  );
}

async function search(page: Page, query: string) {
  const { status, body } = await mcp(page, "tools/call", { name: "search_catalog", arguments: { query } });
  expect(status).toBe(200);
  const result = body?.result as { structuredContent: { products: { id: string; url: string; title: string }[] } };
  return result.structuredContent.products;
}

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    for (const [label, size] of [["1280px", { width: 1280, height: 1000 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      await page.getByRole("switch", { name: "Let AI assistants read my catalog" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 1000 });
}

// Store hosts need a root domain, so this boots a server with PLATFORM_ROOT_DOMAIN=localhost (#572).
test("the owner opts in, and each store host's MCP endpoint answers with its own catalog only", async ({ page }) => {
  test.setTimeout(240_000);
  const port = await reservePort(laneSmokePort());
  const mamaNgozi = `http://mama-ngozi.localhost:${port}`;
  const tanteMarie = `http://tante-marie.localhost:${port}`;
  const root = `http://localhost:${port}`;
  const running = await startSpawnedServer({
    command: `pnpm exec next start -p ${port}`,
    shell: true,
    cwd: process.cwd(),
    port,
    env: {
      ...process.env,
      CI: "true",
      VERCEL: "",
      VERCEL_ENV: "",
      E2E_STORE_OVERRIDE: "",
      STRIPE_SECRET_KEY: "",
      PLATFORM_ROOT_DOMAIN: "localhost",
      BETTER_AUTH_URL: mamaNgozi,
      BETTER_AUTH_TRUSTED_ORIGINS: `${mamaNgozi},${root}`,
    },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthOk: (status) => status === 200 || status === 503,
  });
  try {
    await setReadable(root, "mama-ngozi", false);
    await setReadable(root, "tante-marie", true);

    // Off by default: the endpoint is not there, and the store row is now cached that way.
    await page.goto(`${mamaNgozi}/`);
    expect((await mcp(page, "tools/list")).status).toBe(404);

    await storeOwnerSignIn(page, mamaNgozi);
    await page.goto(`${mamaNgozi}/store-admin/directory?store=mama-ngozi`);
    const toggle = page.getByRole("switch", { name: "Let AI assistants read my catalog" });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(page.getByRole("status").filter({ hasText: "Turned on." })).toBeVisible();
    await expect(toggle).toBeChecked();
    await shoot(page, "572-ai-catalog-settings");

    await page.goto(`${mamaNgozi}/`);
    const tools = await mcp(page, "tools/list");
    expect(tools.status).toBe(200);
    expect(((tools.body?.result as { tools: { name: string }[] }).tools).map((t) => t.name).sort()).toEqual([
      "check_delivery_area",
      "create_checkout_link",
      "get_product",
      "get_store_info",
      "search_catalog",
    ]);
    const atMamaNgozi = await search(page, "egusi");
    expect(atMamaNgozi.length).toBeGreaterThan(0);
    for (const product of atMamaNgozi) expect(product.url).toBe(`${mamaNgozi}/listings/${product.id}`);

    // The same query on the other store's host returns that store's listings, never these.
    await page.goto(`${tanteMarie}/`);
    const atTanteMarie = await search(page, "plantain");
    expect(atTanteMarie.length).toBeGreaterThan(0);
    for (const product of atTanteMarie) expect(product.url.startsWith(`${tanteMarie}/listings/`)).toBe(true);
    const mamaIds = new Set(atMamaNgozi.map((p) => p.id));
    expect((await search(page, "egusi")).some((p) => mamaIds.has(p.id))).toBe(false);

    // A product url an agent hands the shopper opens that product on the storefront.
    await page.goto(atMamaNgozi[0].url);
    await expect(page.getByRole("heading", { level: 1, name: atMamaNgozi[0].title })).toBeVisible();

    // Turning it off takes the endpoint away at once.
    await page.goto(`${mamaNgozi}/store-admin/directory?store=mama-ngozi`);
    await toggle.click();
    await expect(page.getByRole("status").filter({ hasText: "Turned off." })).toBeVisible();
    await page.goto(`${mamaNgozi}/`);
    expect((await mcp(page, "tools/list")).status).toBe(404);
  } finally {
    try {
      await setReadable(root, "mama-ngozi", false);
      await setReadable(root, "tante-marie", false);
    } finally {
      await running.stop();
    }
  }
});
