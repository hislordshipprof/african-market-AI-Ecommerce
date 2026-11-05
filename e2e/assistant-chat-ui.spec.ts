import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { money } from "../src/lib/format";
import { resolveDirectUrl } from "../src/lib/env";
import { WIDE_LAYOUT_STORE, WIDE_LAYOUT_TOKEN, wideLayoutText } from "../src/lib/assistant/fake-model";
import { storeUrl } from "./urls";

const origin = storeUrl("mama-ngozi");
const shots = "C:/E-commerce-project/.builder/screenshots-246";
/** Fake-model reply for "html please". The live region must announce this string, not an image. */
const HTML_REPLY = 'See <img onerror="alert(1)"> and [a](http://evil.test).';
const ROUTE_ERROR = "Sorry, something went wrong. Please try again.";

function bubbles(root: Locator) {
  return root.locator('[class*="bubble"]');
}

function liveRegion(root: Locator) {
  return root.locator('[aria-live="polite"]');
}

async function scriptsHave(page: Page, needle: string): Promise<boolean> {
  return page.evaluate(async (wanted) => {
    const srcs = [...document.scripts].map((script) => script.src).filter(Boolean);
    for (const src of srcs) {
      const text = await fetch(src).then((response) => response.text());
      if (text.includes(wanted)) return true;
    }
    return false;
  }, needle);
}

async function send(page: Page, text: string) {
  await page.getByTestId("assistant-composer").fill(text);
  await page.getByTestId("assistant-send").click();
}

test("the launcher stays out of the first load and the chat chunk arrives on open", async ({ page }) => {
  const chat: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat")) chat.push(request.url());
  });
  await page.goto(`${origin}/`);
  await expect(page.getByTestId("assistant-launcher")).toBeVisible();
  expect(chat).toEqual([]);
  expect(await scriptsHave(page, "assistant-chat-chunk-v1")).toBe(false);
  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByRole("dialog", { name: "Shop with help" })).toBeVisible();
  await expect(page.getByTestId("assistant-composer")).toBeFocused();
  await expect.poll(() => scriptsHave(page, "assistant-chat-chunk-v1")).toBe(true);
  expect(chat).toEqual([]);
});

test("a shopper can add egusi, undo it, and keep the transcript across pages", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.getByRole("button", { name: "Cook a dish" }).click();
  await expect(page.getByTestId("assistant-composer")).toHaveValue("I want to cook ");
  await send(page, "add two egusi");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await expect(dialog.getByRole("button", { name: "Undo", exact: true })).toBeVisible({ timeout: 20_000 });
  const count = page.getByRole("banner").getByTestId("cart-count");
  await expect(count).toHaveText("2");
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Undone", exact: true })).toBeVisible();
  await expect(count).toHaveText("0", { timeout: 10_000 });
  await page.getByRole("button", { name: "Close Shop with help" }).click();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: /Mama Ngozi/ }).first().click();
  await page.getByRole("link", { name: /Tubers/ }).first().click();
  await page.getByTestId("assistant-launcher").click();
  const again = page.getByRole("dialog", { name: "Shop with help" });
  await expect(bubbles(again).filter({ hasText: "add two egusi" })).toBeVisible();
  await expect(again.getByRole("button", { name: "Undone", exact: true })).toBeVisible();
});

test("markup and stray prices stay plain text, and a card number never leaves the browser", async ({ page }) => {
  let posted = "";
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") {
      posted = request.postData() ?? "";
    }
  });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "html please");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await expect(bubbles(dialog).filter({ hasText: HTML_REPLY })).toBeVisible({ timeout: 20_000 });
  await expect(liveRegion(dialog)).toHaveText(HTML_REPLY, { timeout: 20_000 });
  await expect(dialog.locator("img")).toHaveCount(0);
  await send(page, "stray price");
  await expect(dialog.locator('[class*="bubble"]').filter({ hasText: "That is (see card)." })).toBeVisible({ timeout: 20_000 });
  await send(page, "4242424242424242");
  await expect(dialog.locator('[class*="bubble"]').filter({ hasText: "Here is what I found." })).toBeVisible({ timeout: 20_000 });
  expect(posted).not.toContain("4242");
});

test("checkout hides the launcher and the sheet fits a phone without sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${origin}/checkout`);
  await expect(page.getByTestId("assistant-launcher")).toHaveCount(0);
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(wide).toBe(false);
});

test("choice chips and the basket summary are keyboard reachable", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const composer = page.getByTestId("assistant-composer");
  await composer.fill("show me choices of egusi");
  await composer.press("Enter");
  const chip = page.getByLabel("Choice chips").getByRole("button").first();
  await expect(chip).toBeVisible({ timeout: 20_000 });
  for (let step = 0; step < 8; step += 1) {
    if (await chip.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Shift+Tab");
  }
  await expect(chip).toBeFocused();
  const label = (await chip.innerText()).trim();
  const choicePosts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") {
      choicePosts.push(request.postData() ?? "");
    }
  });
  await page.keyboard.press("Enter");
  await expect.poll(() => choicePosts.length).toBe(1);
  expect(choicePosts[0]).toContain(label);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Shop with help" })).toBeHidden();
  await expect(page.getByTestId("assistant-launcher")).toBeVisible();
  await page.getByTestId("assistant-launcher").click();
  await page.getByTestId("assistant-composer").fill("show my basket");
  await page.getByTestId("assistant-composer").press("Enter");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await expect(dialog.getByRole("link", { name: "Looks good" })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('[class*="summary"]').getByText(/to reach the .+ minimum order/)).toBeVisible();
  await page.getByRole("button", { name: "Change something" }).click();
  await expect(page.getByRole("dialog", { name: "Shop with help" })).toBeVisible();
  await expect(page.getByTestId("assistant-composer")).toBeFocused();
  await page.getByRole("link", { name: "Looks good" }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole("dialog", { name: "Shop with help" })).toBeHidden();
});

test("Looks good closes the sheet when the summary starts on the cart", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/cart?from=sheet`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "show my basket");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  const link = dialog.getByRole("link", { name: "Looks good" });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/cart$/);
  await expect(dialog).toBeHidden();
  const launcher = page.getByTestId("assistant-launcher");
  await expect(launcher).toBeVisible();
  await page.screenshot({ path: "test-results/looks-good-cart-390.png" });
  await launcher.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a fake mid-stream failure recovers when the shopper retries", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "mid-stream");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await expect(dialog.getByRole("status").getByText(ROUTE_ERROR)).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.locator('[class*="bubble"]').filter({ hasText: "Recovered after the interruption." })).toBeVisible({ timeout: 20_000 });
});

test("a stream cut after the tool starts shows an error and retry does not add again", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.route("**/api/assistant/chat", async (route) => {
    if (route.request().headers()["x-e2e-full"] === "1") {
      await route.continue();
      return;
    }
    const request = route.request();
    const full = await page.evaluate(async ({ url, body, headers }) => {
      const response = await fetch(url, { method: "POST", headers, body, credentials: "include" });
      return { status: response.status, type: response.headers.get("content-type"), text: await response.text() };
    }, {
      url: request.url(),
      body: request.postData(),
      headers: { ...request.headers(), "x-e2e-full": "1" },
    });
    await route.fulfill({
      status: full.status,
      contentType: full.type ?? "text/event-stream",
      body: full.text.slice(0, 220),
    });
  });
  await send(page, "add two egusi");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await expect(dialog.getByRole("status").getByText(ROUTE_ERROR)).toBeVisible({ timeout: 20_000 });
  const count = page.getByRole("banner").getByTestId("cart-count");
  await expect(count).toHaveText("2", { timeout: 10_000 });
  await page.unroute("**/api/assistant/chat");
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByRole("button", { name: "Undo", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(count).toHaveText("2");
});

test("one submit is one request, and a rejected undo says what happened", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.getByTestId("assistant-composer").fill("add two egusi");
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") posts.push(request.url());
  });
  await page.getByTestId("assistant-composer").evaluate((node) => {
    const form = node.closest("form");
    form?.requestSubmit();
    form?.requestSubmit();
  });
  await expect(page.getByRole("dialog", { name: "Shop with help" }).getByRole("button", { name: "Undo", exact: true })).toBeVisible({ timeout: 20_000 });
  expect(posts).toHaveLength(1);
  await page.context().addCookies([{ name: "e2e_undo", value: "reject", url: origin }]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("Could not undo that")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
});

test("the open sheet is readable at phone and desktop in light and dark", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "show me pictures of egusi");
  await expect(page.locator('[class*="bubble"]').filter({ hasText: "Here is what I found." })).toBeVisible({ timeout: 20_000 });
  const catalog = await page.evaluate(async () => {
    const response = await fetch("/api/storefront/search?q=egusi");
    return response.json() as Promise<{ results: { name: string; price: number }[] }>;
  });
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  expect(catalog.results.length).toBeGreaterThan(0);
  let compared = 0;
  for (const row of catalog.results) {
    const articles = dialog.getByRole("article").filter({ has: page.getByRole("heading", { name: row.name, exact: true }) });
    if (await articles.count() === 0) continue;
    await expect(articles.first()).toContainText(money(row.price));
    compared += 1;
  }
  expect(compared).toBeGreaterThan(0);
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${shots}/sheet-${width}-${scheme}.png`, fullPage: false });
    }
  }
});

const LONG_NAME = `Egusi ${"X".repeat(114)}`;
const CHIP_A = `Yam ${"C".repeat(70)}`;
const CHIP_B = `Yam ${"D".repeat(70)}`;

function ownerPrisma() {
  return new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
}

async function expectWithinScreen(page: Page) {
  const box = await page.evaluate(() => {
    const root = document.documentElement;
    const dialog = document.querySelector("dialog");
    const open = dialog instanceof HTMLDialogElement && dialog.open;
    const log = open ? dialog.querySelector("[class*='log']") : null;
    const bar = document.querySelector("[class*='mobileAction']");
    const barVisible = !!bar && bar.getClientRects().length > 0;
    const measure = (el: Element) => ({ scroll: el.scrollWidth, client: el.clientWidth });
    return {
      root: measure(root),
      dialog: open && dialog ? measure(dialog) : null,
      log: log ? measure(log) : null,
      bar: barVisible && bar ? bar.getBoundingClientRect().right : null,
      viewport: root.clientWidth,
    };
  });
  expect(box.root.scroll).toBeLessThanOrEqual(box.root.client + 1);
  if (box.dialog) expect(box.dialog.scroll).toBeLessThanOrEqual(box.dialog.client + 1);
  if (box.log) expect(box.log.scroll).toBeLessThanOrEqual(box.log.client + 1);
  if (box.bar != null) expect(box.bar).toBeLessThanOrEqual(box.viewport + 1);
}

test("long names, tokens, and the cart bar stay within a 375px screen", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(shots, { recursive: true });
  const prisma = ownerPrisma();
  const store = await prisma.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } });
  let changed: { id: string; customName: string | null }[] = [];
  try {
    changed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      const listings = await tx.listing.findMany({
        where: { storeId: store.id },
        select: { id: true, customName: true, masterProduct: { select: { name: true } } },
      });
      const egusi = listings.filter((row) => /egusi/i.test(row.masterProduct?.name ?? ""));
      const yams = listings.filter((row) => /yam/i.test(row.masterProduct?.name ?? "")).slice(0, 2);
      if (egusi.length === 0 || yams.length < 2) {
        throw new Error(`expected egusi and two yam listings, saw ${egusi.length} and ${yams.length}`);
      }
      await tx.listing.updateMany({
        where: { id: { in: egusi.map((row) => row.id) } },
        data: { customName: LONG_NAME },
      });
      await tx.listing.update({ where: { id: yams[0].id }, data: { customName: CHIP_A } });
      await tx.listing.update({ where: { id: yams[1].id }, data: { customName: CHIP_B } });
      return [...egusi, ...yams].map((row) => ({ id: row.id, customName: row.customName }));
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${origin}/`);
    await page.getByTestId("assistant-launcher").click();
    const dialog = page.getByRole("dialog", { name: "Shop with help" });
    await expect(dialog.getByTestId("assistant-composer")).toBeVisible();
    await expectWithinScreen(page);

    await send(page, `wide layout show me pictures of egusi ${WIDE_LAYOUT_TOKEN} https://example.com/assistant/wide-layout`);
    await expect(dialog.getByRole("heading", { name: LONG_NAME }).first()).toBeVisible({ timeout: 20_000 });
    await expectWithinScreen(page);
    const headerFits = await page.evaluate((storeName) => {
      const heading = document.querySelector("[data-testid='store-name']");
      if (!(heading instanceof HTMLElement)) return false;
      const previous = heading.textContent;
      heading.textContent = storeName;
      const root = document.documentElement;
      const fits = root.scrollWidth <= root.clientWidth + 1;
      heading.textContent = previous;
      return fits && heading.title.length > 0;
    }, WIDE_LAYOUT_STORE);
    expect(headerFits).toBe(true);
    await expect(dialog.locator("[class*='bubble']").filter({ hasText: wideLayoutText() })).toBeVisible({ timeout: 20_000 });
    await expectWithinScreen(page);

    await send(page, "wide layout choices of yam");
    await expect(dialog.getByRole("button", { name: new RegExp(CHIP_A) })).toBeVisible({ timeout: 20_000 });
    await expectWithinScreen(page);

    await send(page, "add two egusi");
    await expect(dialog.getByRole("button", { name: "Undo", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(dialog.locator("article").filter({ has: page.getByRole("button", { name: "Undo", exact: true }) }).getByRole("heading", { name: LONG_NAME })).toBeVisible();
    await expectWithinScreen(page);

    await send(page, "summary");
    await expect(dialog.getByRole("heading", { name: "Your basket" })).toBeVisible({ timeout: 20_000 });
    await expect(dialog.locator("[class*='summary']").getByText(LONG_NAME)).toBeVisible();
    await expectWithinScreen(page);

    await send(page, `${WIDE_LAYOUT_TOKEN} overload https://example.com/assistant/wide-layout`);
    await expect(dialog.getByRole("status").getByText(ROUTE_ERROR)).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole("button", { name: "Retry" })).toBeVisible();
    await expectWithinScreen(page);

    await page.screenshot({ path: `${shots}/wide-sheet-375-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${shots}/wide-sheet-375-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expectWithinScreen(page);
    await page.screenshot({ path: `${shots}/wide-sheet-390-light.png` });
    await page.setViewportSize({ width: 375, height: 812 });

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.goto(`${origin}/cart`);
    await expect(page.getByRole("heading", { name: LONG_NAME })).toBeVisible({ timeout: 20_000 });
    const cartBar = page.locator("[class*='mobileAction']");
    await expect(cartBar).toBeVisible();
    await expect(cartBar.getByText("Subtotal")).toBeVisible();
    await expectWithinScreen(page);
    await page.screenshot({ path: `${shots}/wide-cart-375-light.png` });

    await page.getByTestId("assistant-launcher").click();
    await expect(page.getByRole("dialog", { name: "Shop with help" })).toBeVisible();
    await expectWithinScreen(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Shop with help" })).toBeHidden();

    await page.getByRole("button", { name: /Replace with/ }).first().click();
    const swap = page.getByRole("dialog", { name: "If this item is sold out" });
    await expect(swap.getByText(LONG_NAME).first()).toBeVisible();
    await expectWithinScreen(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectWithinScreen(page);
    await page.screenshot({ path: `${shots}/wide-cart-390-light.png` });
  } finally {
    if (changed.length > 0) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
        for (const row of changed) {
          await tx.listing.update({ where: { id: row.id }, data: { customName: row.customName } });
        }
      });
    }
    await prisma.$disconnect();
  }
});
