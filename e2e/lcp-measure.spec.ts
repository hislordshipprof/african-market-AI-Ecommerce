import { test, expect } from "@playwright/test";

const BASE = "http://mama-ngozi.localhost:3000";

const THROTTLE_4G = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8, // 1.6 Mbps
  uploadThroughput: (750 * 1024) / 8, // 750 Kbps
  latency: 150, // 150ms RTT
};

const CPU_SLOWDOWN = 4; // 4× CPU throttle (simulates mid-tier mobile)

async function measureLCP(
  page: import("@playwright/test").Page,
  url: string,
): Promise<number> {
  const cdp = await page.context().newCDPSession(page);

  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", THROTTLE_4G);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(3000);

  const lcp: number = await page.evaluate(() => {
    return new Promise<number>((resolve) => {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        resolve(last.startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true });
      setTimeout(() => resolve(-1), 5000);
    });
  });

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });
  await cdp.detach();

  return lcp;
}

test.describe("LCP measurement (throttled 4G)", () => {
  test("home page LCP under 2.5s", async ({ page }) => {
    const lcp = await measureLCP(page, `${BASE}/`);
    console.log(`HOME PAGE LCP (4G throttled): ${lcp.toFixed(0)}ms`);
    expect(lcp).toBeGreaterThan(0);
    expect(lcp).toBeLessThan(2500);
  });

  test("product page LCP under 2.5s", async ({ page }) => {
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    const firstCard = page.locator("[data-testid='listing-card']").first();
    await expect(firstCard).toBeVisible({ timeout: 10000 });
    const href = await firstCard.getAttribute("href");
    expect(href).toBeTruthy();

    const lcp = await measureLCP(page, `${BASE}${href}`);
    console.log(`PRODUCT PAGE LCP (4G throttled): ${lcp.toFixed(0)}ms`);
    expect(lcp).toBeGreaterThan(0);
    expect(lcp).toBeLessThan(2500);
  });
});
