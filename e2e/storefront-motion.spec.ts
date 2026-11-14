import { storeUrl } from "./urls";
import { test, expect, type Page, type Route } from "@playwright/test";
const BASE = storeUrl("mama-ngozi");
const PACKS = ["8 oz", "1 lb", "5 lb bag"];

function packButtons(page: Page) {
  return page.getByRole("dialog", { name: /Quick view/ }).getByRole("group", { name: "Choose pack size" }).getByRole("button");
}

async function browserJson(page: Page, url: string): Promise<{ variants?: { id: string; label: string }[]; badge?: string }> {
  const helper = await page.context().newPage();
  try {
    await helper.goto(`${new URL(url).origin}/`);
    return await helper.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`detail ${response.status}`);
      return response.json();
    }, url);
  } finally {
    await helper.close();
  }
}

async function holdListingDetail(page: Page, edit?: (body: { variants?: { id: string; label: string }[]; badge?: string }) => void) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/storefront/listings/**", async (route: Route) => {
    await gate;
    try {
      if (!edit) {
        await route.continue();
        return;
      }
      const json = await browserJson(page, route.request().url());
      edit(json);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
    } catch (error) {
      if (edit) throw error;
    }
  });
  return () => release();
}

async function openEgusi(page: Page) {
  await page.goto(`${BASE}/categories/grains-and-flours`);
  const card = page.getByTestId("listing-card").filter({ hasText: "Egusi" }).first();
  await card.hover();
  const trigger = card.getByRole("button", { name: /Quick view/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /Quick view/ });
  await expect(dialog).toBeVisible();
  return { card, trigger, dialog };
}

async function settleCart(page: Page) {
  const cart = page.getByRole("button", { name: "Shopping cart" });
  await expect(cart).not.toHaveAttribute("data-cart-pending");
  await page.reload();
  await page.getByRole("button", { name: "Shopping cart" }).click();
  return page.getByRole("dialog", { name: "Your cart" });
}

test.describe("Phase 3 motion and depth", () => {
  test.use({ reducedMotion: "no-preference" });
  test("hero autoplay pauses independently on hover and the pause button", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(BASE);
    const hero = page.getByTestId("hero-carousel");
    const dots = hero.getByTestId("carousel-dot");
    await expect(hero).toHaveAttribute("data-autoplay", "running", { timeout: 15_000 });
    await hero.hover();
    await expect(hero).toHaveAttribute("data-autoplay", "paused");
    await page.waitForTimeout(6500);
    await expect(dots.first()).toHaveAttribute("aria-current", "true");
    await hero.getByRole("button", { name: "Pause slideshow" }).click();
    await page.locator(".sf-search-input").first().focus();
    await page.mouse.move(0, 0);
    await expect(hero).toHaveAttribute("data-autoplay", "paused");
    await page.waitForTimeout(6500);
    await expect(dots.first()).toHaveAttribute("aria-current", "true");
    await hero.getByRole("button", { name: "Play slideshow" }).click();
    await page.locator(".sf-search-input").first().focus();
    await page.mouse.move(0, 0);
    await expect(hero).toHaveAttribute("data-autoplay", "running");
    await expect(dots.nth(1)).toHaveAttribute("aria-current", "true", { timeout: 7500 });
  });

  test("scroll-linked band exposes searchable keyboard chips", async ({ page }) => {
    await page.goto(BASE);
    const band = page.getByTestId("market-band");
    await expect(band.getByRole("link")).toHaveCount(6);
    await expect(band.getByRole("button")).toHaveCount(0);
    const chip = band.getByRole("link", { name: "Egusi", exact: true });
    await chip.focus();
    await expect(chip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/search\?q=egusi/);
    await expect(page.getByTestId("listing-card").first()).toContainText(/egusi/i);
  });

  test("hero remains edge to edge and layers overlap during a slide change", async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(BASE, { waitUntil: "networkidle" });
    const stage = page.locator(".sf-hero");
    await expect(stage).toBeVisible();
    await expect(stage).not.toHaveCSS("width", "0px");
    const geometry = await stage.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, viewport: document.documentElement.clientWidth }));
    expect(geometry.left).toBe(0);
    expect(geometry.right).toBe(geometry.viewport);
    await page.getByRole("button", { name: "Next slide", exact: true }).click();
    await expect(page.getByTestId("carousel-dot").nth(1)).toHaveAttribute("aria-current", "true");
    await expect(page.locator(".sf-hero-slide")).toHaveCount(1, { timeout: 3000 });
    await expect(page.locator(".sf-hero-slide")).toHaveCSS("position", "absolute");
    await expect(stage).toHaveCSS("height", "600px");
  });

  for (const vw of [1024, 1280, 1440, 1920]) {
    test(`hero offer tile does not overlap pills or subject label at ${vw}px`, async ({ page }) => {
      await page.setViewportSize({ width: vw, height: 1000 });
      await page.goto(BASE);
      const hero = page.locator(".sf-hero");
      await expect(hero).toBeVisible();
      const offerBox = await page.locator(".sf-hero-offer").boundingBox();
      if (!offerBox) return;
      const overlaps: string[] = [];
      for (const sel of [".sf-glass-one", ".sf-glass-two", ".sf-hero-subject-label"]) {
        const el = page.locator(sel);
        if (await el.count() === 0) continue;
        const vis = await el.isVisible().catch(() => false);
        if (!vis) continue;
        const box = await el.boundingBox();
        if (!box) continue;
        const xOverlap = offerBox.x < box.x + box.width && offerBox.x + offerBox.width > box.x;
        const yOverlap = offerBox.y < box.y + box.height && offerBox.y + offerBox.height > box.y;
        if (xOverlap && yOverlap) overlaps.push(sel);
      }
      expect(overlaps, `Offer tile overlaps at ${vw}px`).toEqual([]);
    });
  }

  test("mobile collection controls and keyboard scrolling agree", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE);
    const collections = page.getByTestId("collection-banners");
    const rail = collections.getByTestId("rail-scroll");
    await collections.scrollIntoViewIfNeeded();
    await expect.poll(() => rail.evaluate(element => element.scrollLeft)).toBe(0);
    await collections.getByRole("button", { name: "Scroll Collections right" }).click();
    await expect.poll(() => rail.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await rail.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => rail.evaluate(element => element.scrollLeft)).toBe(0);
    await page.keyboard.press("End");
    await expect.poll(() => rail.evaluate(element => Math.abs(element.scrollLeft - (element.scrollWidth - element.clientWidth)))).toBeLessThan(2);
  });

  test("quick view opens, selects a pack, adds to cart and restores focus", async ({ page }) => {
    const release = await holdListingDetail(page);
    const { trigger, dialog } = await openEgusi(page);
    await expect(dialog.getByText("Loading pack sizes…")).toBeVisible();
    const packs = packButtons(page);
    await expect(packs).toHaveText(PACKS);
    const five = dialog.getByRole("button", { name: "5 lb bag", exact: true });
    await five.click();
    await expect(five).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: "8 oz", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.getByRole("button", { name: "1 lb", exact: true })).toHaveAttribute("aria-pressed", "false");
    release();
    await expect(dialog.getByText("Add to your basket")).toBeVisible();
    await expect(packs).toHaveText(PACKS);
    await expect(five).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: "8 oz", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.getByLabel("$79.99")).toBeVisible();
    await dialog.getByTestId("quick-add-btn").click();
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
    await dialog.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    const cart = await settleCart(page);
    await expect(cart.getByRole("listitem")).toHaveCount(1);
    await expect(cart).toContainText("$79.99 / 5 lb bag");
  });

  test("quick view says when the chosen pack is gone and adds only the new pick", async ({ page }) => {
    const release = await holdListingDetail(page, (body) => {
      body.variants = body.variants?.filter((variant) => variant.label !== "1 lb");
    });
    const { dialog } = await openEgusi(page);
    await expect(dialog.getByText("Loading pack sizes…")).toBeVisible();
    await dialog.getByRole("button", { name: "1 lb", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "1 lb", exact: true })).toHaveAttribute("aria-pressed", "true");
    release();
    await expect(dialog.getByRole("status")).toHaveText("The 1 lb pack is no longer available. Choose another pack size.");
    await expect(packButtons(page)).toHaveText(["8 oz", "5 lb bag"]);
    for (const button of await packButtons(page).all()) {
      await expect(button).toHaveAttribute("aria-pressed", "false");
    }
    await expect(dialog.getByTestId("quick-add-btn")).toBeDisabled();
    await dialog.getByRole("button", { name: "8 oz", exact: true }).click();
    await expect(dialog.getByTestId("quick-add-btn")).toBeEnabled();
    await dialog.getByTestId("quick-add-btn").click();
    const cart = await settleCart(page);
    await expect(cart.getByRole("listitem")).toHaveCount(1);
    await expect(cart).toContainText("$10.99 / 8 oz");
    await expect(cart).not.toContainText("1 lb");
  });

  test("latest real click wins across a held detail response", async ({ page }) => {
    const release = await holdListingDetail(page);
    const { dialog } = await openEgusi(page);
    await expect(dialog.getByText("Loading pack sizes…")).toBeVisible();
    await dialog.getByRole("button", { name: "1 lb", exact: true }).click();
    await dialog.getByRole("button", { name: "5 lb bag", exact: true }).click();
    await dialog.getByRole("button", { name: "5 lb bag", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "5 lb bag", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: "1 lb", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.getByRole("button", { name: "8 oz", exact: true })).toHaveAttribute("aria-pressed", "false");
    release();
    await expect(dialog.getByText("Add to your basket")).toBeVisible();
    await expect(packButtons(page)).toHaveText(PACKS);
    await expect(dialog.getByRole("button", { name: "5 lb bag", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: "1 lb", exact: true })).toHaveAttribute("aria-pressed", "false");
    await dialog.getByRole("button", { name: "1 lb", exact: true }).click();
    await expect(dialog.getByRole("group", { name: "Choose pack size" }).getByRole("button", { pressed: true })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "1 lb", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: "5 lb bag", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.getByRole("button", { name: "8 oz", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.getByLabel("$18.99")).toBeVisible();
    await dialog.getByTestId("quick-add-btn").click();
    const cart = await settleCart(page);
    await expect(cart.getByRole("listitem")).toHaveCount(1);
    await expect(cart).toContainText("$18.99 / 1 lb");
    await expect(cart).not.toContainText("5 lb bag");
  });

  test("closing the quick view before details arrive leaves no errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    let egusiFailure = "pending";
    page.on("requestfailed", (request) => {
      if (egusiFailure === "pending" && request.url().includes("/api/storefront/listings/mn_egusi")) {
        egusiFailure = request.failure()?.errorText ?? "failed";
      }
    });
    page.on("requestfinished", (request) => {
      if (egusiFailure === "pending" && request.url().includes("/api/storefront/listings/mn_egusi")) {
        egusiFailure = "finished";
      }
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/storefront/listings/**", async (route) => {
      if (!route.request().url().includes("mn_egusi")) {
        await route.continue();
        return;
      }
      await gate;
      try {
        await route.continue();
      } catch {
        // The browser already aborted this request. requestfailed records the reason.
      }
    });
    const { dialog } = await openEgusi(page);
    await expect(dialog.getByText("Loading pack sizes…")).toBeVisible();
    await dialog.getByRole("button", { name: "5 lb bag", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "5 lb bag", exact: true })).toHaveAttribute("aria-pressed", "true");
    await dialog.press("Escape");
    await expect(dialog).toBeHidden();
    const ofada = page.getByTestId("listing-card").filter({ hasText: "Ofada Rice" }).first();
    await ofada.hover();
    await ofada.getByRole("button", { name: /Quick view/ }).click();
    const other = page.getByRole("dialog", { name: "Quick view: Ofada Rice" });
    await expect(other.getByText("Add to your basket")).toBeVisible();
    await expect(other.getByRole("group", { name: "Choose pack size" }).getByRole("button")).toHaveText(["2 lb", "10 lb bag"]);
    await expect(other.getByRole("button", { name: "2 lb", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(other.getByLabel("$8.99")).toBeVisible();
    release();
    await expect.poll(() => egusiFailure).toMatch(/net::ERR_ABORTED/);
    await expect(other.getByRole("button", { name: "2 lb", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(other.getByRole("button", { name: "5 lb bag", exact: true })).toHaveCount(0);
    await other.getByTestId("quick-add-btn").click();
    await expect(other.getByTestId("stepper-qty")).toHaveText("1");
    await expect(page.getByRole("button", { name: "Shopping cart" })).not.toHaveAttribute("data-cart-pending");
    await other.press("Escape");
    const ofadaCart = await settleCart(page);
    await expect(ofadaCart.getByRole("listitem")).toHaveCount(1);
    await expect(ofadaCart).toContainText("$8.99 / 2 lb");
    await expect(ofadaCart).not.toContainText("5 lb bag");
    await page.keyboard.press("Escape");
    const egusi = page.getByTestId("listing-card").filter({ hasText: "Egusi" }).first();
    await egusi.hover();
    await egusi.getByRole("button", { name: /Quick view/ }).click();
    const reopened = page.getByRole("dialog", { name: /Quick view: Egusi/ });
    await expect(reopened.getByText("Add to your basket")).toBeVisible();
    await expect(reopened.getByRole("button", { name: "8 oz", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(reopened.getByRole("button", { name: "5 lb bag", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(reopened.getByRole("status")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("two adds and existing-line plus settle to one selected-variant line", async ({ page }) => {
    let releaseAdd: () => void = () => {};
    const addGate = new Promise<void>((resolve) => { releaseAdd = resolve; });
    await page.route("**/*", async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) await addGate;
      try { await route.continue(); } catch { /* the page navigated */ }
    });
    const { dialog } = await openEgusi(page);
    await expect(dialog.getByText("Add to your basket")).toBeVisible();
    await dialog.getByRole("button", { name: "5 lb bag", exact: true }).click();
    await dialog.getByTestId("quick-add-btn").click();
    await expect(dialog.getByTestId("stepper-qty")).toHaveText("1");
    const cartButton = page.getByRole("button", { name: "Shopping cart" });
    await expect(cartButton).toHaveAttribute("data-cart-pending", "true");
    await dialog.getByTestId("stepper-plus").click();
    await expect(dialog.getByTestId("stepper-qty")).toHaveText("2");
    await expect(cartButton).toHaveAttribute("data-cart-pending", "true");
    releaseAdd();
    await expect(cartButton).not.toHaveAttribute("data-cart-pending");
    const pendingCart = await settleCart(page);
    await expect(pendingCart.getByRole("listitem")).toHaveCount(1);
    await expect(pendingCart.getByTestId("stepper-qty")).toHaveText("2");
    await expect(pendingCart).toContainText("$79.99 / 5 lb bag");
    await page.keyboard.press("Escape");
    const again = await openEgusi(page);
    await expect(again.dialog.getByText("Add to your basket")).toBeVisible();
    await again.dialog.getByRole("button", { name: "5 lb bag", exact: true }).click();
    await expect(again.dialog.getByTestId("stepper-qty")).toHaveText("2");
    await again.dialog.getByTestId("stepper-plus").click();
    await expect(again.dialog.getByTestId("stepper-qty")).toHaveText("3");
    await expect(page.getByRole("button", { name: "Shopping cart" })).not.toHaveAttribute("data-cart-pending");
    const settled = await settleCart(page);
    await expect(settled.getByRole("listitem")).toHaveCount(1);
    await expect(settled.getByTestId("stepper-qty")).toHaveText("3");
    await expect(settled).toContainText("$79.99 / 5 lb bag");
  });

  test("loading failure and ask-store details disable add and existing-line plus", async ({ page }) => {
    const { dialog } = await openEgusi(page);
    await expect(dialog.getByText("Add to your basket")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "8 oz", exact: true })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByTestId("quick-add-btn").click();
    await expect(dialog.getByTestId("stepper-qty")).toHaveText("1");
    await expect(page.getByRole("button", { name: "Shopping cart" })).not.toHaveAttribute("data-cart-pending");
    await dialog.press("Escape");
    const release = await holdListingDetail(page);
    const loading = await openEgusi(page);
    await expect(loading.dialog.getByText("Loading pack sizes…")).toBeVisible();
    await expect(loading.dialog.getByTestId("stepper-plus")).toBeDisabled();
    release();
    await expect(loading.dialog.getByText("Add to your basket")).toBeVisible();
    await expect(loading.dialog.getByTestId("stepper-plus")).toBeEnabled();
    await loading.dialog.press("Escape");
    await page.unroute("**/api/storefront/listings/**");
    await page.route("**/api/storefront/listings/**", async (route) => {
      const json = await browserJson(page, route.request().url());
      json.badge = "ask-store";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
    });
    const ask = await openEgusi(page);
    await expect(ask.dialog.getByText("Add to your basket")).toBeVisible();
    await expect(ask.dialog.getByTestId("stepper-plus")).toBeDisabled();
    await expect(ask.dialog.getByRole("status")).toHaveCount(0);
    await ask.dialog.press("Escape");
    await page.unroute("**/api/storefront/listings/**");
    await page.route("**/api/storefront/listings/**", async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "failed" }) });
    });
    const failed = await openEgusi(page);
    await expect(failed.dialog.getByRole("status")).toHaveText("Pack details could not load. Open the product page to try again.");
    await expect(failed.dialog.getByText("no longer available")).toHaveCount(0);
    await expect(failed.dialog.getByTestId("stepper-plus")).toBeDisabled();
  });

  test("category pack filter reaches the actual quick view default", async ({ page }) => {
    const release = await holdListingDetail(page);
    await page.goto(`${BASE}/categories/grains-and-flours?sizes=1`);
    const fivePound = page.getByTestId("filter-pack-option").filter({ hasText: "5 lb bag" });
    await fivePound.click();
    // The chip is a navigation. Opening quick view before it commits uses the
    // unfiltered pack, so aria-pressed on "5 lb bag" is false under load.
    await expect(fivePound).toHaveAttribute("aria-current", "page");
    const card = page.getByTestId("listing-card").filter({ hasText: "Egusi" }).first();
    await expect(card).toContainText("5 lb bag");
    await card.hover();
    await card.getByRole("button", { name: /Quick view/ }).click();
    const dialog = page.getByRole("dialog", { name: /Quick view/ });
    await expect(dialog.getByText("Loading pack sizes…")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "5 lb bag", exact: true })).toHaveAttribute("aria-pressed", "true");
    release();
    await expect(dialog.getByText("Add to your basket")).toBeVisible();
    await expect(packButtons(page)).toHaveText(PACKS);
    await expect(dialog.getByRole("button", { name: "5 lb bag", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: "8 oz", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.getByLabel("$79.99")).toBeVisible();
  });

  test("warm and overlapping A B detail requests remain store scoped", async ({ browser }) => {
    const mama = await browser.newContext();
    const tante = await browser.newContext();
    const mamaPage = await mama.newPage();
    const tantePage = await tante.newPage();
    const read = (page: Page, path: string) => page.evaluate(async (path) => {
      const response = await fetch(path);
      return { status: response.status, text: await response.text() };
    }, path);
    await mamaPage.goto(storeUrl("mama-ngozi"));
    await tantePage.goto(storeUrl("tante-marie"));
    const warm = await read(mamaPage, "/api/storefront/listings/mn_egusi");
    expect(warm.status).toBe(200);
    expect(JSON.parse(warm.text).variants.map((variant: { label: string }) => variant.label)).toEqual(PACKS);
    const [again, foreign, own] = await Promise.all([
      read(mamaPage, "/api/storefront/listings/mn_egusi"),
      read(tantePage, "/api/storefront/listings/mn_egusi"),
      read(tantePage, "/api/storefront/listings/tm_egusi"),
    ]);
    expect(again.status).toBe(200);
    expect(JSON.parse(again.text).id).toBe("mn_egusi");
    expect(foreign.status).toBe(404);
    expect(JSON.parse(foreign.text)).toEqual({ error: "Listing not found" });
    expect(own.status).toBe(200);
    const ownBody = JSON.parse(own.text);
    expect(ownBody.id).toBe("tm_egusi");
    expect(ownBody.variants.every((variant: { id: string }) => variant.id.startsWith("tm_"))).toBe(true);
    const mamaShelf = await mamaPage.goto(`${storeUrl("mama-ngozi")}/collections/soup-essentials`);
    expect(mamaShelf?.status()).toBe(200);
    await expect(mamaPage.getByRole("heading", { name: "Soup essentials" })).toBeVisible();
    await expect(mamaPage.getByRole("link", { name: "View Egusi (Melon Seeds)" })).toBeVisible();
    await tantePage.goto(`${storeUrl("tante-marie")}/collections/soup-essentials`);
    await expect(tantePage.getByRole("heading", { level: 1 })).toHaveText("Tante Marie Caribbean Grocer");
    await expect(tantePage.getByTestId("page-not-found")).toBeVisible();
    await expect(tantePage.getByRole("heading", { name: "Soup essentials" })).toHaveCount(0);
    await expect(tantePage.getByText("mn_egusi")).toHaveCount(0);
    await mama.close();
    await tante.close();
  });

  test("fly-to-cart updates the accessible badge immediately", async ({ page }) => {
    await page.goto(`${BASE}/categories/grains-and-flours`);
    await page.waitForTimeout(2000);
    const card = page.getByTestId("listing-card").filter({ has: page.locator('[data-testid="quick-add-btn"]:enabled') }).filter({ hasNot: page.locator(".sf-product-fallback") }).first();
    await expect(card.locator("img")).toBeVisible();
    await expect.poll(() => card.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await card.getByTestId("quick-add-btn").click();
    await expect(page.getByTestId("cart-flight")).toHaveCount(1);
    const header = page.getByTestId("storefront-header");
    await expect(header.getByTestId("cart-count")).toHaveText("1");
    await expect(header.locator('[aria-live="polite"]')).toContainText("1 item in cart");
    await expect(page.getByTestId("cart-flight")).toHaveCount(0);
  });

  test("unknown paths retain store branding with search and aisles", async ({ page }) => {
    await page.goto(`${BASE}/c/grains-flours`);
    await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
    await expect(page.getByTestId("store-name")).toHaveText("Mama Ngozi African Market");
    await expect(page.getByTestId("page-not-found").getByRole("link", { name: /Grains/ })).toBeVisible();
    await page.getByLabel("Search the store", { exact: true }).fill("egusi");
    await page.getByTestId("page-not-found").getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/search\?q=egusi/);
  });

  test("exact local search match is first and incidental matches are absent", async ({ page }) => {
    await page.goto(`${BASE}/search?q=egusi`);
    const names = page.getByTestId("listing-card").locator(".sf-product-name");
    await expect(names.first()).toContainText(/egusi/i);
    expect(await names.allTextContents()).not.toEqual(expect.arrayContaining([expect.stringMatching(/cassava|garden eggs/i)]));
  });

  test("reduced motion disables autoplay and keeps static wrapping chips", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(BASE);
    await expect(page.getByTestId("hero-carousel")).toHaveAttribute("data-autoplay", "paused");
    await expect(page.getByRole("button", { name: "Play slideshow" })).toBeDisabled();
    await expect(page.locator("html")).not.toHaveClass(/sf-reveal-ready/);
    await expect(page.locator(".sf-market-track")).toHaveCSS("transform", "none");
    await expect(page.locator(".sf-market-track")).toHaveCSS("flex-wrap", "wrap");
    await expect(page.getByTestId("market-band").getByRole("link")).toHaveCount(6);
  });
});
