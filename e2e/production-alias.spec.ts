import { mkdirSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { ALIAS, ALIAS_LAUNCH, serveVercelHostsFrom, startAliasServer } from "./vercel-hosts";

const PREVIEW = "african-market-ai-ecommerce-git-main-team.vercel.app";
const SHOTS = process.env.PROOF_DIR ?? "screenshots";

test.use(ALIAS_LAUNCH);
test.describe.configure({ mode: "serial" });

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [label, size] of [["1280px", { width: 1280, height: 1000 }], ["390px", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/766-${name}-${label}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
}

test("the production alias serves the directory, /sell, the admin and stores, noindex; a preview host still serves nothing", async ({ page, context }) => {
  test.setTimeout(240_000);
  const running = await startAliasServer();
  try {
    await serveVercelHostsFrom(context, running.port);

    const home = await page.goto(`https://${ALIAS}/`);
    expect(home?.headers()["x-robots-tag"]).toBe("noindex");
    await expect(page).toHaveTitle(/Store directory/);
    await expect(page.getByText("Store not found")).toHaveCount(0);
    const card = page.getByRole("link", { name: /Mama Ngozi African Market/ }).first();
    await expect(card).toHaveAttribute("href", `https://${ALIAS}/?store=mama-ngozi&ref=directory`);
    await shoot(page, "directory");

    // State and city pages are ISR output shared with every server on this build, so other specs'
    // servers would read what this one renders; directoryOrigin's unit test covers their canonical URL.
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

    // The marketplace's own pages forget the store, so their links to / lead home.
    await page.goto(`https://${ALIAS}/sell`);
    await page.getByRole("link", { name: "Globe Grocer", exact: true }).click();
    await expect(page).toHaveTitle(/Store directory/);

    const admin = await page.goto(`https://${ALIAS}/admin/sign-in`);
    expect(admin?.headers()["x-robots-tag"]).toBe("noindex");
    await expect(page.getByRole("heading", { name: "Platform Admin" })).toBeVisible();

    const preview = await page.goto(`https://${PREVIEW}/?store=mama-ngozi`);
    expect(preview?.headers()["x-robots-tag"]).toBeUndefined();
    await expect(page).toHaveTitle("Store not found");
    const sell = await page.goto(`https://${PREVIEW}/sell`);
    expect(sell?.status()).toBe(404);
  } finally {
    await running.stop();
  }
});
