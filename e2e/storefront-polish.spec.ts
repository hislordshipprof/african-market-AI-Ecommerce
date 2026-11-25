import { storeUrl } from "./urls";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { deleteGuestOrder, insertGuestOrder } from "./order-fixture";

const BASE = storeUrl("mama-ngozi");

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const bottomNav = (page: Page) => page.getByRole("navigation", { name: "Main navigation", exact: true });

test.describe("Storefront layout on a phone (#529)", () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });

  test("the product add bar sits above the bottom nav", async ({ page }) => {
    await page.goto(`${BASE}/listings/mn_egusi`, { waitUntil: "networkidle" });
    const addBar = page.locator(".sf-add-bar");
    await expect(addBar).toBeVisible();
    expect(overlap(await box(addBar), await box(bottomNav(page)))).toBe(false);
  });

  test("a related product's name stays clear of its add button", async ({ page }) => {
    // Semovita's aisle (Fufu, Flours & Swallow) has demo listings without photos, so the rail shows illustrations.
    await page.goto(`${BASE}/listings/mn_semovita`, { waitUntil: "networkidle" });
    const related = page.locator("section", { has: page.getByRole("heading", { name: "More from this aisle" }) });
    const photos = related.locator(".sf-product-photo", { has: page.getByTestId("designed-image-fallback") });
    const count = await photos.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const photo = photos.nth(i);
      await photo.scrollIntoViewIfNeeded();
      const name = await box(photo.getByTestId("designed-image-fallback").locator("span"));
      const add = await box(photo.locator(".sf-quick-add button").first());
      expect(overlap(name, add)).toBe(false);
    }
  });

  test("the Shop with AI launcher sits above the bottom nav", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    const launcher = page.getByTestId("assistant-launcher").first();
    await expect(launcher).toBeVisible();
    expect(overlap(await box(launcher), await box(bottomNav(page)))).toBe(false);
  });

  test("below the minimum, the basket bar says why Checkout is off and takes the nav's place", async ({ page }) => {
    await page.goto(`${BASE}/listings/mn_egusi`, { waitUntil: "networkidle" });
    await page.getByTestId("product-detail").getByTestId("quick-add-btn").first().click();
    await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("1");
    await page.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
    const bar = page.locator("div", { has: page.getByRole("button", { name: "Checkout", disabled: true }) })
      .filter({ hasText: "Subtotal" }).last();
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(/minimum/i);
    // One bottom region on the basket page (#708 P1): the bar replaces the nav, so nothing stacks over the lines.
    await expect(bottomNav(page)).toBeHidden();
  });

  test("text fields are at least 16px, so a phone does not zoom on focus", async ({ page }) => {
    await page.goto(`${BASE}/listings/mn_egusi`, { waitUntil: "networkidle" });
    await page.getByTestId("product-detail").getByTestId("quick-add-btn").first().click();
    await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden({ timeout: 20_000 });
    await page.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
    const fields = await page.evaluate(() =>
      [...document.querySelectorAll("input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select, textarea")]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => ({ field: el.id || el.getAttribute("placeholder") || el.tagName, size: parseFloat(getComputedStyle(el).fontSize) })),
    );
    expect(fields.length).toBeGreaterThan(3);
    expect(fields.filter((f) => f.size < 16)).toEqual([]);
  });
});

test("order tracking names each line's product and size, and the fulfillment in words (#529)", async ({ page }) => {
  const seeded = await insertGuestOrder({
    email: `e2e-polish-${Date.now()}@test.example`,
    name: "Polish Guest",
    phone: "+15550005290",
  });
  try {
    await page.goto(`${BASE}/order/${seeded.orderId}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("region", { name: "Completed" })).toContainText(/Fulfillment:?\s*Pickup/);
    const details = page.locator("section", { has: page.getByRole("heading", { name: "Receipt" }) });
    const lineName = seeded.lineName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await expect(details.getByRole("listitem").first()).toHaveText(new RegExp(`^1 × ${lineName}\\s*\\$12\\.50$`));
  } finally {
    await deleteGuestOrder(seeded);
  }
});

/** WCAG relative luminance of a computed `rgb()` or `color(srgb …)` value. */
function luminance(css: string): number {
  const srgb = css.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
  const channels = srgb
    ? srgb.slice(1, 4).map(Number)
    : (css.match(/[\d.]+/g) ?? []).slice(0, 3).map((n) => Number(n) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test.describe("Stepper focus ring on the green pill (#743 AC2)", () => {
  for (const slug of ["mama-ngozi", "tante-marie"]) {
    for (const scheme of ["light", "dark"] as const) {
      test(`${slug}, ${scheme}: the focused button's ring is painted inside the pill at 3:1 or more`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await page.goto(`${storeUrl(slug)}/`, { waitUntil: "networkidle" });
        await page.getByTestId("listing-card").getByTestId("quick-add-btn").first().click();
        // The one item in the basket, so the only stepper on the page.
        const minus = page.getByTestId("stepper-minus").first();
        await expect(minus).toBeVisible();
        // Reached by keyboard, so :focus-visible applies.
        await minus.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(minus).toBeFocused();
        const ring = await minus.evaluate((el) => {
          const pill = el.parentElement!;
          const s = getComputedStyle(el);
          const b = el.getBoundingClientRect();
          const p = pill.getBoundingClientRect();
          return {
            focusVisible: el.matches(":focus-visible"),
            style: s.outlineStyle,
            color: s.outlineColor,
            width: parseFloat(s.outlineWidth),
            offset: parseFloat(s.outlineOffset),
            pill: getComputedStyle(pill).backgroundColor,
            clips: getComputedStyle(pill).overflow === "hidden",
            insidePill: b.left >= p.left - 0.5 && b.right <= p.right + 0.5 && b.top >= p.top - 0.5 && b.bottom <= p.bottom + 0.5,
          };
        });
        expect(ring.focusVisible).toBe(true);
        expect(ring.style).not.toBe("none");
        expect(ring.width).toBeGreaterThanOrEqual(2);
        // The pill clips its buttons, so a ring drawn outside the button is cut off: it must sit inside it.
        expect(ring.clips && ring.insidePill).toBe(true);
        expect(ring.offset + ring.width).toBeLessThanOrEqual(0);
        expect(contrast(ring.color, ring.pill)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});
