import { storeUrl } from "./urls";
import { test, expect } from "@playwright/test";

const BASE = storeUrl("mama-ngozi");

test.describe("Storefront redesign interactions", () => {
  test.use({ reducedMotion: "reduce" });

  test("carousel supports next, previous and keyboard navigation", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto(BASE, { waitUntil: "networkidle" });
    const carousel = page.getByTestId("hero-carousel");
    const dots = carousel.getByTestId("carousel-dot");
    await expect(dots.nth(1)).toBeVisible();
    const initialTitle = await carousel.getByTestId("banner-title").innerText();
    await carousel
      .getByRole("button", { name: "Next slide", exact: true })
      .click();
    await expect(dots.nth(1)).toHaveAttribute("aria-current", "true", { timeout: 10_000 });
    await expect(carousel.getByTestId("banner-title")).not.toHaveText(
      initialTitle,
    );
    await carousel
      .getByRole("button", { name: "Previous slide", exact: true })
      .click();
    await expect(dots.first()).toHaveAttribute("aria-current", "true", { timeout: 10_000 });
    await expect(carousel.getByTestId("banner-title")).toHaveText(initialTitle);
    const keyboardTarget = carousel.locator("[tabindex='0']");
    await keyboardTarget.focus();
    await keyboardTarget.press("ArrowRight");
    await expect(dots.nth(1)).toHaveAttribute("aria-current", "true", { timeout: 10_000 });
    await keyboardTarget.press("ArrowLeft");
    await expect(dots.first()).toHaveAttribute("aria-current", "true", { timeout: 10_000 });
    await keyboardTarget.press("End");
    await expect(dots.last()).toHaveAttribute("aria-current", "true", { timeout: 10_000 });
    await keyboardTarget.press("Home");
    await expect(dots.first()).toHaveAttribute("aria-current", "true", { timeout: 10_000 });
  });

  test("quick add expands, updates cart count and creates a drawer line", async ({
    page,
  }) => {
    await page.goto(`${BASE}/categories/fufu-flours-and-swallow`);
    const addableCard = page
      .getByTestId("listing-card")
      .filter({ has: page.locator("[data-testid=quick-add-btn]:enabled") })
      .first();
    const name = await addableCard.locator(".sf-product-name").innerText();
    await addableCard.getByTestId("quick-add-btn").click();
    const card = page
      .getByTestId("listing-card")
      .filter({ hasText: name })
      .first();
    await expect(card.getByTestId("quick-add-stepper")).toBeVisible();
    await expect(card.getByTestId("stepper-qty")).toHaveText("1");
    await card.getByTestId("stepper-plus").click();
    await expect(card.getByTestId("stepper-qty")).toHaveText("2");
    const header = page.getByTestId("storefront-header");
    await expect(header.getByTestId("cart-count")).toHaveText("2");
    await header
      .getByRole("button", { name: /in basket$|^Basket$/ })
      .click();
    const cart = page.getByRole("dialog", { name: "Your basket" });
    await expect(cart).toBeVisible();
    await expect(
      cart.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(cart.getByTestId("stepper-qty")).toHaveText("2");
    await cart.getByTestId("stepper-minus").click();
    await expect(header.getByTestId("cart-count")).toHaveText("1");
    await cart.getByRole("button", { name: "Close basket" }).click();
    await expect(cart).not.toBeVisible();
  });

  test("category in-stock filter only shows in-stock cards", async ({
    page,
  }) => {
    await page.goto(`${BASE}/categories/fufu-flours-and-swallow`);
    await page.getByTestId("filter-in-stock").click();
    await expect(page).toHaveURL(/stock=1/);
    await expect(page.getByTestId("filter-in-stock")).toHaveAttribute(
      "aria-current",
      "page",
    );
    const badges = page.getByTestId("listing-card").getByTestId("stock-badge");
    await expect(badges.first()).toBeVisible();
    for (const badge of await badges.all())
      await expect(badge).toHaveText("In stock");
    await page.getByTestId("clear-filters").first().click();
    await expect(page).toHaveURL(`${BASE}/categories/fufu-flours-and-swallow`);
  });

  test("category frozen and pack filters reflect actual product metadata", async ({
    page,
  }) => {
    await page.goto(`${BASE}/categories/fresh-produce`);
    await page.getByTestId("filter-frozen").click();
    await expect(page).toHaveURL(/frozen=1/);
    const cards = page.getByTestId("listing-card");
    await expect
      .poll(async () => {
        const countText = await page.locator(".sf-result-count").innerText();
        const shown = Number(countText.match(/^(\d+)/)?.[1]);
        const n = await cards.count();
        if (!shown || n !== shown) return false;
        const tags = await cards.locator(".sf-photo-tag").allTextContents();
        return tags.length === n && tags.every((tag) => tag === "Frozen");
      })
      .toBe(true);
    const label = await cards
      .first()
      .locator(".sf-product-meta > span")
      .first()
      .innerText();
    await page.getByTestId("filter-pack-size").click();
    const pack = page.getByRole("link", { name: label, exact: true });
    await pack.click();
    await expect(
      page.getByTestId("filter-pack-option").filter({ hasText: label }).first(),
    ).toHaveAttribute("aria-current", "page");
    await expect
      .poll(async () => {
        const countText = await page.locator(".sf-result-count").innerText();
        const shown = Number(countText.match(/^(\d+)/)?.[1]);
        const n = await cards.count();
        if (!shown || n !== shown) return false;
        const metas = await cards.locator(".sf-product-meta").allTextContents();
        return metas.length === n && metas.every((meta) => meta.includes(label));
      })
      .toBe(true);
  });

  test("instant synonym search opens a scoped product", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.keyboard.press("/");
    const search = page.locator("#storefront-search");
    await expect(search).toBeFocused();
    await search.fill("ugu");
    const dropdown = page.getByTestId("instant-results");
    const product = dropdown.locator('a[href^="/listings/"]').first();
    await expect(product).toBeVisible();
    await expect(product).toContainText(/ugu|fluted pumpkin/i);
    await product.click();
    await expect(page).toHaveURL(/\/listings\//);
    await expect(page.getByTestId("product-detail")).toContainText(
      /ugu|fluted pumpkin/i,
    );
  });

  test("folded phone header keeps search results and the ZIP form usable", async ({
    page,
  }) => {
    // clip-path hides and un-hits an overlay without failing toBeVisible, so hit-test its centre.
    const hitInside = (selector: string) =>
      page.locator(selector).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && el.contains(hit);
      });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/categories/fufu-flours-and-swallow`, { waitUntil: "networkidle" });
    const header = page.getByTestId("storefront-header");

    await page.locator(".sf-window-chip").click();
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect(header).toHaveAttribute("data-compact", "true");
    await expect.poll(() => hitInside("#delivery-zip")).toBe(true);
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.locator("#storefront-search").fill("egusi");
    await expect(page.getByTestId("instant-results")).toBeVisible();
    await expect.poll(() => hitInside("[data-testid='instant-results']")).toBe(true);
  });

  test("pack selection changes displayed price and cart pack", async ({
    page,
  }) => {
    await page.goto(`${BASE}/categories/fufu-flours-and-swallow`);
    await page
      .getByTestId("listing-card")
      .filter({ hasText: "Garri" })
      .first()
      .locator(".sf-product-name")
      .click();
    const detail = page.getByTestId("product-detail");
    const options = detail.getByTestId("pack-option");
    await expect(options.nth(1)).toBeVisible();
    const selected = options.nth(1);
    const packLabel = (await selected.innerText()).split("\n")[0];
    const previousPrice = await detail
      .locator(".sf-detail-copy > .sf-price")
      .innerText();
    await selected.click();
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await expect(options.first()).toHaveAttribute("aria-pressed", "false");
    await expect(detail.locator(".sf-detail-copy > .sf-price")).not.toHaveText(
      previousPrice,
    );
    await detail.getByTestId("quick-add-btn").click();
    await page
      .getByTestId("storefront-header")
      .getByRole("button", { name: /in basket$|^Basket$/ })
      .click();
    await expect(page.getByRole("dialog", { name: "Your basket" })).toContainText(
      packLabel,
    );
  });

  test("the product page asks for the pack before the add (#708 P2)", async ({ page }) => {
    await page.goto(`${BASE}/categories/fufu-flours-and-swallow`);
    await page.getByTestId("listing-card").filter({ hasText: "Garri" }).first().locator(".sf-product-name").click();
    const detail = page.getByTestId("product-detail");
    await expect(detail.getByTestId("pack-option").nth(1)).toBeVisible();
    const sizesFirst = await detail.evaluate((root) => {
      const sizes = root.querySelector("[aria-labelledby='variants-heading']");
      const bar = root.querySelector(".sf-add-bar");
      return Boolean(sizes && bar && sizes.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(sizesFirst).toBe(true);
    const second = detail.getByTestId("pack-option").nth(1);
    const label = (await second.innerText()).split("\n")[0];
    await second.click();
    await expect(detail.locator(".sf-add-bar")).toContainText(label);
  });

  test("mobile bottom navigation reaches categories, search, account and home", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE, { waitUntil: "networkidle" });
    const nav = page.getByRole("navigation", {
      name: "Main navigation",
      exact: true,
    });
    await expect(nav).toBeVisible();
    for (const [label, path] of [
      ["Aisles", "/categories"],
      ["Search", "/search"],
      ["Account", "/account"],
      ["Home", "/"],
    ]) {
      await nav.getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(`${BASE}${path}`, { timeout: 15_000 });
      await expect(
        nav.getByRole("link", { name: label, exact: true }),
      ).toHaveAttribute("aria-current", "page");
    }
    await nav.getByRole("button", { name: /in basket$|^Basket$/ }).click();
    const cart = page.getByRole("dialog", { name: "Your basket" });
    await expect(cart).toBeVisible();
    await expect(cart).toContainText("Your basket is empty");
    await cart.getByRole("button", { name: "Close basket" }).click();
    await expect(cart).not.toBeVisible();
  });
});

test.describe("phone occlusion (#708 P1, #717 AC5)", () => {
  test.use({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });

  type Box = { x: number; y: number; width: number; height: number };
  const overlaps = (a: Box, b: Box) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  test("Shop with AI never covers card copy or quick add while the grid scrolls", async ({ page }) => {
    await page.goto(`${BASE}/categories/fufu-flours-and-swallow`);
    const launcher = page.getByTestId("assistant-launcher");
    await expect(launcher).toBeVisible();
    await expect(page.getByTestId("listing-card").first()).toBeVisible();
    for (const y of [0, 500, 1000, 1600]) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(100);
      const box = await launcher.boundingBox();
      if (!box) continue;
      const targets = await page.locator(".sf-product-copy, .sf-quick-add").evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }),
      );
      for (const target of targets) expect(overlaps(box, target), `launcher over a card at scrollY ${y}`).toBe(false);
    }
  });

  test("the first basket line is clear of the checkout bar and nav at the top of the page", async ({ page }) => {
    await page.goto(`${BASE}/categories/fufu-flours-and-swallow`);
    const card = page.getByTestId("listing-card").filter({ hasText: "Yellow Garri" }).first();
    await card.getByTestId("quick-add-btn").click();
    await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden({ timeout: 20_000 });
    await page.goto(`${BASE}/cart`);
    const line = page.locator("main").getByRole("listitem").filter({ hasText: "Yellow Garri" });
    await expect(line).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    const fixed = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((node) => {
          const style = getComputedStyle(node);
          return style.position === "fixed" && style.display !== "none" && style.visibility !== "hidden" && node.getBoundingClientRect().height > 0;
        })
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })
        .filter((rect) => rect.y > 300),
    );
    for (const part of [line.getByRole("heading"), line.getByTestId("stepper-qty")]) {
      const box = await part.boundingBox();
      expect(box, "line part rendered").not.toBeNull();
      expect(box!.y + box!.height, "line part inside the viewport").toBeLessThanOrEqual(844);
      for (const rect of fixed) expect(overlaps(box!, rect), "a fixed bar covers the first line").toBe(false);
    }
  });
});
