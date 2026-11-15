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
    await expect(card).toHaveAttribute("href", `http://mama-ngozi.localhost:${port}/?ref=directory`);
    await expect(page.getByText("Tante Marie Caribbean Grocer")).toHaveCount(0);
    await expect(page).toHaveTitle(/Store directory/);

    await card.click();
    await expect(page).toHaveURL(`http://mama-ngozi.localhost:${port}/?ref=directory`);
    await expect(page).toHaveTitle("Mama Ngozi African Market");
    // #454: the store's own host keeps a first-party cookie that says only "directory".
    const storeCookies = await page.context().cookies(`http://mama-ngozi.localhost:${port}`);
    expect(storeCookies.filter((cookie) => cookie.name === "came_from").map((cookie) => cookie.value)).toEqual(["directory"]);
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
    // #454: the dashboard counts the orders the directory sent.
    await expect(page.getByRole("link", { name: /Directory listing/ })).toContainText(/\d+ orders? from the directory/);
    await shoot(page, "454-dashboard", "Dashboard");
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
    await expect(card).toHaveAttribute("href", `http://mama-ngozi.localhost:${port}/?ref=directory`);
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

    // 77001 is a real Houston ZIP of PO boxes only, so the Census ZIP areas leave it out.
    await page.getByLabel("ZIP code or city").fill("77001");
    await page.getByRole("button", { name: "Find stores" }).click();
    await expect(page.getByText(/try your city/i)).toBeVisible();
    await expect(page.getByText(/check the spelling/i)).toHaveCount(0);
    await denied.close();

    // A granted location abroad shows the state list.
    const abroad = await browser.newContext({ permissions: ["geolocation"], geolocation: { latitude: 51.5074, longitude: -0.1278 } });
    const away = await abroad.newPage();
    await away.goto(`${root}/`);
    await away.getByRole("button", { name: "Use my location" }).click();
    await expect(away.getByText("You look to be outside the US.")).toBeVisible();
    await expect(away.getByRole("heading", { name: "Browse by state" })).toBeVisible();
    await expect(away.getByRole("link", { name: "Mama Ngozi African Market" })).toHaveAttribute("href", `http://mama-ngozi.localhost:${port}/?ref=directory`);
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

async function rootServer(port: number, extra: Record<string, string> = {}) {
  return startSpawnedServer({
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
      ...extra,
    },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthOk: (status) => status === 200 || status === 503,
  });
}

// State and city pages (#451) on a root-domain server. Mama Ngozi is the seeded listed store, in Houston, TX.
test("state and city pages: cached, GroceryStore JSON-LD, sitemap and robots, 404 for an empty city, LCP on slow 4G", async ({ page, browser, request }) => {
  test.setTimeout(240_000);
  const port = await reservePort(laneSmokePort());
  const root = `http://localhost:${port}`;
  const running = await rootServer(port);
  try {
    await page.goto(`${root}/stores/texas`);
    await expect(page.getByRole("heading", { level: 1, name: "African grocery stores in Texas" })).toBeVisible();
    await expect(page).toHaveTitle("African grocery stores in Texas · African Markets");
    await expect(page.getByRole("link", { name: /Mama Ngozi African Market/ })).toHaveAttribute("href", `http://mama-ngozi.localhost:${port}/?ref=directory`);
    await page.getByRole("link", { name: /^Houston/ }).click();
    await expect(page).toHaveURL(`${root}/stores/texas/houston`);
    await expect(page.getByRole("heading", { level: 1, name: "African grocery stores in Houston, TX" })).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${root}/stores/texas/houston`);

    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(ld.map((text) => JSON.parse(text))).toEqual([{
      "@context": "https://schema.org",
      "@type": "GroceryStore",
      name: "Mama Ngozi African Market",
      url: `http://mama-ngozi.localhost:${port}/`,
      image: `http://mama-ngozi.localhost:${port}/logos/mama-ngozi-logo.svg`,
      description: SEEDED.listingBlurb,
      address: { "@type": "PostalAddress", addressLocality: "Houston", addressRegion: "TX", addressCountry: "US" },
    }]);
    await shoot(page, "451-city", "African grocery stores in Houston, TX");
    await page.goto(`${root}/stores/texas`);
    await shoot(page, "451-state", "African grocery stores in Texas");

    // The second request is served from the ISR cache, not rendered again.
    expect((await request.get(`${root}/stores/texas/houston`)).headers()["x-nextjs-cache"]).toBe("HIT");

    for (const path of ["/stores/texas/austin", "/stores/ohio", "/stores/tx", "/stores/texas/houston-tx"]) {
      expect((await request.get(`${root}${path}`)).status(), path).toBe(404);
    }
    await page.goto(`${root}/stores/texas/austin`);
    await expect(page.getByRole("heading", { name: "No stores listed here yet" })).toBeVisible();

    const sitemap = await request.get(`${root}/sitemap.xml`);
    expect(sitemap.status()).toBe(200);
    const xml = await sitemap.text();
    for (const url of [`${root}/`, `${root}/stores/texas`, `${root}/stores/texas/houston`]) expect(xml).toContain(`<loc>${url}</loc>`);
    expect(xml).not.toContain("mama-ngozi.localhost");
    const robots = await request.get(`${root}/robots.txt`);
    expect(await robots.text()).toContain(`Sitemap: ${root}/sitemap.xml`);

    // Store hosts never serve the directory's pages, sitemap or robots.txt.
    for (const path of ["/stores/texas", "/stores/texas/houston", "/sitemap.xml", "/robots.txt"]) {
      expect((await request.get(`http://mama-ngozi.localhost:${port}${path}`)).status(), path).toBe(404);
    }

    // Lighthouse's mobile slow 4G as DevTools applies it: 562.5 ms latency, 1.47 Mbps down, 4x CPU slowdown, cold cache.
    const slow = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await slow.newPage();
    const cdp = await slow.newCDPSession(phone);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 562.5, downloadThroughput: (1474.56 * 1024) / 8, uploadThroughput: (607.5 * 1024) / 8 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await phone.goto(`${root}/stores/texas/houston`, { waitUntil: "load" });
    const lcp = await phone.evaluate(() => new Promise<number>((resolve) => {
      new PerformanceObserver((list) => resolve(list.getEntries().at(-1)!.startTime)).observe({ type: "largest-contentful-paint", buffered: true });
    }));
    console.log(`LCP on slow 4G: ${Math.round(lcp)} ms`);
    expect(lcp).toBeLessThan(2500);
    await slow.close();
  } finally {
    await running.stop();
  }
});

// The listing switch clears the cached state and city pages on the next request (#451).
test("unlisting the only Houston store turns its city page into a 404 at once, and listing it brings the page back", async ({ page, request }) => {
  test.setTimeout(240_000);
  const port = await reservePort(laneSmokePort());
  const store = `http://mama-ngozi.localhost:${port}`;
  const root = `http://localhost:${port}`;
  const running = await rootServer(port, { BETTER_AUTH_URL: store, BETTER_AUTH_TRUSTED_ORIGINS: `${store},${root}` });
  const city = `${root}/stores/texas/houston`;
  try {
    expect((await request.get(city)).status()).toBe(200);
    expect((await request.get(city)).headers()["x-nextjs-cache"]).toBe("HIT");

    await storeOwnerSignIn(page, store);
    await page.goto(`${store}/store-admin/directory?store=mama-ngozi`);
    const listed = page.getByRole("switch", { name: "Listed in the directory" });
    await expect(listed).toBeChecked();
    await listed.click();
    await page.getByRole("button", { name: "Save listing" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    expect((await request.get(city)).status()).toBe(404);
    expect((await request.get(`${root}/stores/texas`)).status()).toBe(404);
    expect(await (await request.get(`${root}/sitemap.xml`)).text()).not.toContain("/stores/texas");

    await listed.click();
    await page.getByRole("button", { name: "Save listing" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    expect((await request.get(city)).status()).toBe(200);
    // Also refreshes the cached state page, so the next server does not start from its 404.
    expect((await request.get(`${root}/stores/texas`)).status()).toBe(200);
    expect(await (await request.get(`${root}/sitemap.xml`)).text()).toContain(`<loc>${city}</loc>`);
    await page.goto(city);
    await expect(page.getByRole("link", { name: /Mama Ngozi African Market/ })).toBeVisible();
  } finally {
    await restoreSeed();
    await running.stop();
  }
});

// Store cards (#453). Mama Ngozi is seeded in Houston (America/Chicago) with pickup, its own delivery within 8 miles
// and an owner story; ZIP 77002 is about 5 miles away. The browser clock is fixed, so open and closed never depend on the hour.
test("store cards: open now or opens at from the browser clock, distance, pickup and delivers to you, the owner's face and story", async ({ browser }) => {
  test.setTimeout(240_000);
  const port = await reservePort(laneSmokePort());
  const root = `http://localhost:${port}`;
  const running = await rootServer(port);
  try {
    const context = await browser.newContext({ timezoneId: "America/Chicago" });
    const page = await context.newPage();
    // Monday 16 Nov 2026, 10:00 in Houston.
    await page.clock.setFixedTime(new Date("2026-11-16T16:00:00Z"));
    await page.goto(`${root}/`);
    const card = page.getByRole("link", { name: /Mama Ngozi African Market/ });
    await expect(card).toContainText("Open now");
    await expect(card).toContainText("Pickup");
    await expect(card).toContainText("Delivery");
    await expect(card).not.toContainText("Delivers to you");
    await expect(card).toContainText("Run by Ngozi Okafor");
    await expect(card).toContainText("bringing the flavors of home");
    await expect(card).toContainText("West African");

    await page.getByLabel("ZIP code or city").fill("77002");
    await page.getByRole("button", { name: "Find stores" }).click();
    await expect(page.getByRole("heading", { name: "Stores near 77002" })).toBeVisible();
    const near = page.getByRole("region", { name: "Stores near 77002" }).getByRole("link", { name: /Mama Ngozi African Market/ });
    await expect(near).toContainText(/\d\.\d mi away/);
    await expect(near).toContainText("Delivers to you");
    await shoot(page, "453-card-near-open", "Stores near 77002");
    await context.close();

    // The cached city page, read at 08:30 on a Monday in Houston: the hours come from the browser, not the cache.
    const early = await browser.newContext({ timezoneId: "America/Chicago" });
    const city = await early.newPage();
    await city.clock.setFixedTime(new Date("2026-11-16T14:30:00Z"));
    await city.goto(`${root}/stores/texas/houston`);
    const closed = city.getByRole("link", { name: /Mama Ngozi African Market/ });
    await expect(closed).toContainText("Closed");
    await expect(closed).toContainText("Opens 9 AM");
    await expect(closed).not.toContainText("Open now");
    await shoot(city, "453-card-city-closed", "African grocery stores in Houston, TX");
    await early.close();

    // A shopper in New York sees the store's own clock, with its zone named.
    const east = await browser.newContext({ timezoneId: "America/New_York" });
    const away = await east.newPage();
    await away.clock.setFixedTime(new Date("2026-11-16T14:30:00Z"));
    await away.goto(`${root}/stores/texas`);
    await expect(away.getByRole("link", { name: /Mama Ngozi African Market/ })).toContainText("Opens 9 AM CST");
    await east.close();
  } finally {
    await running.stop();
  }
});
