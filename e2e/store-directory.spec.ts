import { mkdirSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { laneSmokePort, reservePort, startSpawnedServer } from "./spawned-server";
import { storeOwnerSignIn } from "./store-owner-auth";

// Both tests read Mama Ngozi's listing and the second changes it, so they never overlap.
test.describe.configure({ mode: "serial" });

const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const SEEDED = {
  listed: true,
  listingBlurb: "Nigerian and West African groceries in Houston since 2009: fresh yam, egusi, palm oil and stockfish.",
  cuisineTags: ["west-african"],
};

async function restoreSeed(): Promise<void> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) return;
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.store.update({ where: { slug: "mama-ngozi" }, data: SEEDED });
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function shoot(page: Page, name: string, heading: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    for (const [label, size] of [["1280px", { width: 1280, height: 1000 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      await page.getByRole("heading", { name: heading }).first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 1000 });
}

// The lane server has no root domain, so this boots one with PLATFORM_ROOT_DOMAIN=localhost (#449).
test("the root domain serves the Store directory and store hosts still serve their storefront", async ({ page }) => {
  test.setTimeout(180_000);
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
      VERCEL_ENV: "",
      E2E_STORE_OVERRIDE: "",
      STRIPE_SECRET_KEY: "",
      PLATFORM_ROOT_DOMAIN: "localhost",
      BETTER_AUTH_URL: `http://localhost:${port}`,
      BETTER_AUTH_TRUSTED_ORIGINS: `http://localhost:${port}`,
    },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthOk: (status) => status === 200 || status === 503,
  });
  try {
    await page.goto(`http://localhost:${port}/`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Store not found")).toHaveCount(0);
    const card = page.getByRole("link", { name: /Mama Ngozi African Market/ });
    await expect(card).toHaveAttribute("href", `http://mama-ngozi.localhost:${port}/`);
    await expect(page.getByText("Tante Marie Caribbean Grocer")).toHaveCount(0);
    await expect(page).toHaveTitle(/Store directory/);

    await card.click();
    await expect(page).toHaveURL(`http://mama-ngozi.localhost:${port}/`);
    await expect(page).toHaveTitle("Mama Ngozi African Market");
  } finally {
    await running.stop();
  }
});

// The directory lives on the root domain, so this boots a server with PLATFORM_ROOT_DOMAIN=localhost
// and signs the owner in on the store's subdomain of it (#450).
test("the owner lists the store, writes the blurb and picks cuisines; the directory shows it at once", async ({ page }) => {
  test.setTimeout(240_000);
  const port = await reservePort(laneSmokePort());
  const store = `http://mama-ngozi.localhost:${port}`;
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
      BETTER_AUTH_URL: store,
      BETTER_AUTH_TRUSTED_ORIGINS: `${store},${root}`,
    },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthOk: (status) => status === 200 || status === 503,
  });
  const blurb = `Fresh yam, egusi and Scotch bonnet every Friday. Run ${Date.now().toString(36)}.`;
  try {
    // Warm the directory cache, so a stale entry would show if the save did not clear it.
    await page.goto(`${root}/`);
    await expect(page.getByText(SEEDED.listingBlurb)).toBeVisible();

    await storeOwnerSignIn(page, store);
    await page.goto(`${store}/store-admin?store=mama-ngozi`);
    await page.getByRole("link", { name: /Directory listing/ }).click();
    await expect(page).toHaveURL(/\/store-admin\/directory/);
    await expect(page.getByRole("heading", { name: "Directory listing" })).toBeVisible();

    const listed = page.getByRole("switch", { name: "Listed in the directory" });
    await expect(listed).toBeChecked();
    await page.getByLabel("Short description").fill(blurb);
    await page.getByRole("button", { name: "Caribbean" }).click();
    await expect(page.getByRole("button", { name: "Caribbean" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "East African" }).click();
    await expect(page.getByRole("button", { name: "Latin American" })).toBeDisabled();

    await page.getByLabel("Short description").fill("x".repeat(161));
    await expect(page.getByText("1 characters over the 160 limit")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save listing" })).toBeDisabled();
    await page.getByLabel("Short description").fill(blurb);

    await page.getByRole("button", { name: "Save listing" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await shoot(page, "450-directory-settings", "Directory listing");

    await page.reload();
    await expect(page.getByLabel("Short description")).toHaveValue(blurb);

    await page.goto(`${root}/`);
    const card = page.getByRole("link", { name: /Mama Ngozi African Market/ });
    await expect(card).toContainText(blurb);
    await expect(card).toContainText("West African · East African · Caribbean");
    await shoot(page, "450-directory-card", "Find an African grocery store near you");

    await page.goto(`${store}/store-admin/directory?store=mama-ngozi`);
    await listed.click();
    await expect(listed).not.toBeChecked();
    await page.getByRole("button", { name: "Save listing" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await page.goto(`${root}/`);
    await expect(page.getByRole("link", { name: /Mama Ngozi African Market/ })).toHaveCount(0);

    // Put the seed back through the page, so the directory cache is cleared as well.
    await page.goto(`${store}/store-admin/directory?store=mama-ngozi`);
    await listed.click();
    await page.getByLabel("Short description").fill(SEEDED.listingBlurb);
    await page.getByRole("button", { name: "Caribbean" }).click();
    await page.getByRole("button", { name: "East African" }).click();
    await page.getByRole("button", { name: "Save listing" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await page.goto(`${root}/`);
    await expect(page.getByText(SEEDED.listingBlurb)).toBeVisible();
  } finally {
    await restoreSeed();
    await running.stop();
  }
});

// Near me (#452) on a root-domain server. Mama Ngozi is seeded in Houston, about 5 miles from ZIP 77002.
test("near me: location only on a tap, a denied location focuses the ZIP field, nearest first, the state list beyond the US", async ({ browser }) => {
  test.setTimeout(240_000);
  const port = await reservePort(laneSmokePort());
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
      BETTER_AUTH_URL: root,
      BETTER_AUTH_TRUSTED_ORIGINS: root,
    },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthOk: (status) => status === 200 || status === 503,
  });
  try {
    // Counts location requests, and answers them as the browser would if the shopper said no.
    const denied = await browser.newContext();
    await denied.addInitScript(() => {
      const w = window as unknown as { locationAsks: number };
      w.locationAsks = 0;
      navigator.geolocation.getCurrentPosition = (_ok, fail) => {
        w.locationAsks += 1;
        fail?.({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: "denied" } as GeolocationPositionError);
      };
    });
    const page = await denied.newPage();
    await page.goto(`${root}/`);
    await expect(page.getByRole("link", { name: /Mama Ngozi African Market/ })).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { locationAsks: number }).locationAsks)).toBe(0);

    await page.getByRole("button", { name: "Use my location" }).click();
    expect(await page.evaluate(() => (window as unknown as { locationAsks: number }).locationAsks)).toBe(1);
    await expect(page.getByText("Location is off for this site. Enter your ZIP code or city instead.")).toBeVisible();
    await expect(page.getByLabel("ZIP code or city")).toBeFocused();
    await shoot(page, "452-near-denied", "Find an African grocery store near you");

    await page.getByLabel("ZIP code or city").fill("77002");
    await page.getByRole("button", { name: "Find stores" }).click();
    await expect(page.getByRole("heading", { name: "Stores near 77002" })).toBeVisible();
    const card = page.getByRole("link", { name: /Mama Ngozi African Market/ });
    await expect(card).toContainText(/\d\.\d mi/);
    await expect(card).toHaveAttribute("href", `http://mama-ngozi.localhost:${port}/`);
    await shoot(page, "452-near-zip", "Stores near 77002");

    await page.getByLabel("ZIP code or city").fill("New York, NY");
    await page.getByRole("button", { name: "Find stores" }).click();
    await expect(page.getByRole("heading", { name: "No stores within 50 miles of New York, NY" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Mama Ngozi African Market Houston/ })).toContainText(/1,\d{3} mi/);
    await expect(page.getByRole("heading", { name: "Browse by state" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Texas", level: 3 })).toBeVisible();
    await shoot(page, "452-near-fallback", "No stores within 50 miles of New York, NY");

    await page.getByLabel("ZIP code or city").fill("Springfield");
    await page.getByRole("button", { name: "Find stores" }).click();
    await page.getByRole("button", { name: "Springfield, IL" }).click();
    await expect(page.getByRole("heading", { name: "No stores within 50 miles of Springfield, IL" })).toBeVisible();
    await denied.close();

    // A granted location abroad shows the state list.
    const abroad = await browser.newContext({ permissions: ["geolocation"], geolocation: { latitude: 51.5074, longitude: -0.1278 } });
    const away = await abroad.newPage();
    await away.goto(`${root}/`);
    await away.getByRole("button", { name: "Use my location" }).click();
    await expect(away.getByText("You look to be outside the US.")).toBeVisible();
    await expect(away.getByRole("heading", { name: "Browse by state" })).toBeVisible();
    await expect(away.getByRole("link", { name: "Mama Ngozi African Market" })).toHaveAttribute("href", `http://mama-ngozi.localhost:${port}/`);
    await shoot(away, "452-near-outside", "Browse by state");
    await abroad.close();

    const houston = await browser.newContext({ permissions: ["geolocation"], geolocation: { latitude: 29.7604, longitude: -95.3698 } });
    const near = await houston.newPage();
    await near.goto(`${root}/`);
    await near.getByRole("button", { name: "Use my location" }).click();
    await expect(near.getByRole("heading", { name: "Stores near you" })).toBeVisible();
    await expect(near.getByRole("link", { name: /Mama Ngozi African Market/ })).toContainText(/\d\.\d mi/);
    await houston.close();
  } finally {
    await running.stop();
  }
});
