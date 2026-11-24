import { mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { laneSmokePort, reservePort, startSpawnedServer } from "./spawned-server";

// #766: until PLATFORM_ROOT_DOMAIN is set, the production alias serves the marketplace and stores by ?store=.
const ALIAS = "african-market-ai-ecommerce.vercel.app";
const PREVIEW = "african-market-ai-ecommerce-git-main-team.vercel.app";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";

// Nothing may reach the real vercel.app hosts: they resolve to this machine, and every request to them
// is answered by the local server with the Host header Vercel would send.
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP *.vercel.app 127.0.0.1"] } });
test.describe.configure({ mode: "serial" });

async function serveVercelHostsFrom(context: BrowserContext, port: number) {
  await context.route(
    (url) => url.hostname.endsWith(".vercel.app"),
    async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({
        url: `http://127.0.0.1:${port}${url.pathname}${url.search}`,
        headers: { ...route.request().headers(), host: url.hostname, "x-forwarded-proto": "https" },
        maxRedirects: 0,
      });
      // Chromium sends the target of a fulfilled redirect to the network, past the route, so the redirect
      // is replayed as a page that moves on; its cookies are kept.
      const location = response.headers().location;
      if (response.status() >= 300 && response.status() < 400 && location) {
        const target = new URL(location, url).toString();
        const { location: _, ...headers } = response.headers();
        await route.fulfill({ status: 200, headers: { ...headers, "content-type": "text/html" }, body: `<meta http-equiv="refresh" content="0;url=${target}">` });
        return;
      }
      await route.fulfill({ response });
    },
  );
}

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [label, size] of [["1280px", { width: 1280, height: 1000 }], ["390px", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/766-${name}-${label}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
}

test("the production alias serves the directory, /sell and stores, noindex; a preview host still serves nothing", async ({ page, context }) => {
  test.setTimeout(240_000);
  const port = await reservePort(laneSmokePort());
  const running = await startSpawnedServer({
    command: `pnpm exec next start -p ${port}`,
    shell: true,
    cwd: process.cwd(),
    port,
    env: {
      ...process.env,
      CI: "true",
      VERCEL: "",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: ALIAS,
      PLATFORM_ROOT_DOMAIN: "",
      E2E_STORE_OVERRIDE: "",
      STRIPE_SECRET_KEY: "",
      // A production deployment refuses the committed test secret.
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
      BETTER_AUTH_URL: `https://${ALIAS}`,
      BETTER_AUTH_TRUSTED_ORIGINS: "",
    },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthOk: (status) => status === 200 || status === 503,
  });
  try {
    await serveVercelHostsFrom(context, port);

    const home = await page.goto(`https://${ALIAS}/`);
    expect(home?.headers()["x-robots-tag"]).toBe("noindex");
    await expect(page).toHaveTitle(/Store directory/);
    await expect(page.getByText("Store not found")).toHaveCount(0);
    const card = page.getByRole("link", { name: /Mama Ngozi African Market/ }).first();
    await expect(card).toHaveAttribute("href", `https://${ALIAS}/?store=mama-ngozi&ref=directory`);
    await shoot(page, "directory");

    await page.goto(`https://${ALIAS}/stores/texas`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Texas");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://${ALIAS}/stores/texas`);

    await page.goto(`https://${ALIAS}/sell`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Store not found")).toHaveCount(0);
    await shoot(page, "sell");

    await page.goto(`https://${ALIAS}/`);
    await page.getByRole("link", { name: /Mama Ngozi African Market/ }).first().click();
    await expect(page).toHaveURL(`https://${ALIAS}/?ref=directory`);
    await expect(page).toHaveTitle("Mama Ngozi African Market");
    const cookies = await context.cookies(`https://${ALIAS}`);
    expect(cookies.find((c) => c.name === "store_override")?.value).toBe("mama-ngozi");
    expect(cookies.find((c) => c.name === "came_from")?.value).toBe("directory");
    // A storefront page stays on the store.
    await page.goto(`https://${ALIAS}/categories`);
    await expect(page).toHaveTitle(/Mama Ngozi African Market/);
    await page.goto(`https://${ALIAS}/`);
    await shoot(page, "store");

    // The marketplace's own pages forget the store, so its "All stores" link leads home.
    await page.goto(`https://${ALIAS}/stores/texas`);
    await page.getByRole("link", { name: "All stores" }).click();
    await expect(page).toHaveTitle(/Store directory/);

    const preview = await page.goto(`https://${PREVIEW}/?store=mama-ngozi`);
    expect(preview?.headers()["x-robots-tag"]).toBeUndefined();
    await expect(page).toHaveTitle("Store not found");
    const sell = await page.goto(`https://${PREVIEW}/sell`);
    expect(sell?.status()).toBe(404);
  } finally {
    await running.stop();
  }
});
