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
    await page.goto(`${BASE}/categories/grains-and-flours`);
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
      .getByRole("button", { name: "Shopping cart", exact: true })
      .click();
    const cart = page.getByRole("dialog", { name: "Your cart" });
    await expect(cart).toBeVisible();
    await expect(
      cart.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(cart.getByTestId("stepper-qty")).toHaveText("2");
    await cart.getByTestId("stepper-minus").click();
    await expect(header.getByTestId("cart-count")).toHaveText("1");
    await cart.getByRole("button", { name: "Close cart" }).click();
    await expect(cart).not.toBeVisible();
  });

  test("category in-stock filter only shows in-stock cards", async ({
    page,
  }) => {
    await page.goto(`${BASE}/categories/grains-and-flours`);
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
    await expect(page).toHaveURL(`${BASE}/categories/grains-and-flours`);
  });

  test("category frozen and pack filters reflect actual product metadata", async ({
    page,
  }) => {
    await page.goto(`${BASE}/categories/vegetables`);
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

  test("pack selection changes displayed price and cart pack", async ({
    page,
  }) => {
    await page.goto(`${BASE}/categories/grains-and-flours`);
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
      .getByRole("button", { name: "Shopping cart", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "Your cart" })).toContainText(
      packLabel,
    );
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
      ["Categories", "/categories"],
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
    await nav.getByRole("button", { name: "Shopping cart", exact: true }).click();
    const cart = page.getByRole("dialog", { name: "Your cart" });
    await expect(cart).toBeVisible();
    await expect(cart).toContainText("Your next good meal starts here");
    await cart.getByRole("button", { name: "Close cart" }).click();
    await expect(cart).not.toBeVisible();
  });
});
