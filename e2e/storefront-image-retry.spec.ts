import { storeUrl } from "./urls";
import { test, expect } from "@playwright/test";

const BASE = storeUrl("mama-ngozi");
const WIDTH = "256";

function optimizerPath(src: string) {
  return `/_next/image?${new URLSearchParams({ url: src, w: WIDTH, q: "75" }).toString()}`;
}

const denied = [
  "/api/catalog-image/catalog/x.jpg?retry=2",
  "/api/catalog-image/catalog/x.jpg?foo=1",
  "/api/catalog-image/catalog/x.jpg?retry=1&x=1",
  "/api/catalog-image/catalog/x.jpg?retry=01",
  "/api/catalog-image/catalog/x.jpg?Retry=1",
  "/api/catalog-image/catalog/x.jpg?retry=1&",
  "/images/products/garri-yellow.webp?v=1",
  "/images/market-bodija.webp?retry=1",
  "/favicon.ico?retry=1",
];

test.describe("optimizer accepts ProductImage's single local retry", () => {
  test("a cutout retry returns an image", async ({ request }) => {
    const res = await request.get(optimizerPath("/images/products/garri-yellow.webp?retry=1"));
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^image\//);
  });

  test("a catalog retry is not refused as an unconfigured local pattern", async ({ request }) => {
    const res = await request.get(optimizerPath("/api/catalog-image/catalog/yam.jpg?retry=1"));
    expect(res.status(), "pattern miss is 400; a missing key is the route's 404").not.toBe(400);
    expect([200, 404]).toContain(res.status());
  });

  test("query variants and retries outside the two prefixes are refused", async ({ request }) => {
    for (const src of denied) {
      const res = await request.get(optimizerPath(src));
      expect(res.status(), src).toBe(400);
    }
  });

  test("the same paths without a query are not a pattern miss", async ({ request }) => {
    const bare = [...new Set(denied.map((src) => src.split("?")[0]))];
    for (const src of bare) {
      const res = await request.get(optimizerPath(src));
      expect(res.status(), src).not.toBe(400);
    }
    const cutout = await request.get(optimizerPath("/images/products/garri-yellow.webp"));
    expect(cutout.status()).toBe(200);
    expect(cutout.headers()["content-type"]).toMatch(/^image\//);
  });

  test("five callers of one retry URL see the same non-400 status", async ({ request }) => {
    const statuses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request.get(optimizerPath("/images/products/garri-yellow.webp?retry=1")).then((res) => res.status()),
      ),
    );
    expect(new Set(statuses).size).toBe(1);
    expect(statuses[0]).not.toBe(400);
    expect(statuses[0]).toBe(200);
  });

  test("the storefront lets a failed photo's retry through and shows the photo", async ({ page }) => {
    const retryResponses: Promise<number | null>[] = [];
    page.on("request", (request) => {
      if (!request.url().includes("/_next/image")) return;
      const src = new URL(request.url()).searchParams.get("url") ?? "";
      if (!src.includes("retry=1")) return;
      retryResponses.push(request.response().then((response) => response?.status() ?? null));
    });
    await page.route("**/_next/image**", async (route) => {
      const src = new URL(route.request().url()).searchParams.get("url") ?? "";
      if (src.includes("retry=1")) {
        await route.continue();
        return;
      }
      await route.abort("failed");
    });
    await page.goto(`${BASE}/categories/grains-and-flours`);
    const shown = page.locator(".sf-product-image").filter({ has: page.locator("img") });
    await expect(shown.first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => retryResponses.length, { timeout: 15_000 }).toBeGreaterThan(0);
    let statuses: Array<number | null> = [];
    await expect.poll(async () => {
      const started = retryResponses.slice();
      statuses = await Promise.all(started);
      return retryResponses.length === started.length && statuses.every((status) => status !== null);
    }, { timeout: 15_000 }).toBe(true);
    expect(statuses, "a pattern miss is 400").not.toContain(400);
    await expect(shown.first()).not.toContainText("Photo unavailable");
  });
});
