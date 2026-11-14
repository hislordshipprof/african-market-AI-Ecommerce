import { storeUrl } from "./urls";
import { test, expect } from "@playwright/test";

const BASE = storeUrl("mama-ngozi");

test.describe("product image states", () => {
  test("a listing with no accepted photo shows the designed fallback, never 'Photo unavailable'", async ({ page }) => {
    await page.goto(`${BASE}/categories/grains-and-flours`);
    const cards = page.getByTestId("listing-card");
    await expect(cards.first()).toBeVisible();
    const designed = cards.filter({ has: page.getByTestId("designed-image-fallback") });
    expect(await designed.count(), "seed must leave at least one listing without a photo").toBeGreaterThan(0);
    const card = designed.first();
    await expect(card.getByTestId("designed-image-fallback")).toBeVisible();
    await expect(card.getByTestId("designed-image-fallback")).toHaveAttribute("role", "img");
    await expect(card.getByText("Photo unavailable")).toHaveCount(0);
    await expect(card.locator("img")).toHaveCount(0);
  });

  test("a failing photo retries once with ?retry=1, then shows 'Photo unavailable'", async ({ page }) => {
    const requested: string[] = [];
    await page.route("**/_next/image**", route => {
      requested.push(decodeURIComponent(new URL(route.request().url()).searchParams.get("url") ?? ""));
      return route.abort("failed");
    });
    await page.goto(`${BASE}/categories/grains-and-flours`);
    const unavailable = page.getByTestId("listing-card").filter({ hasText: "Photo unavailable" }).first();
    await expect(unavailable).toBeVisible({ timeout: 15_000 });
    await expect(unavailable.getByRole("img", { name: /^Photo temporarily unavailable for / })).toBeVisible();
    await expect(unavailable.getByTestId("designed-image-fallback")).toHaveCount(0);
    await expect(unavailable.locator("img")).toHaveCount(0);
    // Several cards can share one source, so compare counts per source rather than assuming one card.
    const retried = requested.filter(u => u.includes("retry=1"));
    expect(retried.length).toBeGreaterThan(0);
    expect(requested.filter(u => /retry=(?!1$)/.test(u)), "never a second retry").toEqual([]);
    for (const retrySrc of new Set(retried)) {
      const original = retrySrc.replace(/[?&]retry=1$/, "");
      const originalCount = requested.filter(u => u === original).length;
      expect(originalCount, "each source is tried before it is retried").toBeGreaterThan(0);
      expect(requested.filter(u => u === retrySrc).length, "no more retries than failed originals").toBeLessThanOrEqual(originalCount);
    }
  });
});
