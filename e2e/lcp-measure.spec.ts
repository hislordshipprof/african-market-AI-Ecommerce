import { test, expect } from "@playwright/test";

const BASE = "http://mama-ngozi.localhost:3000";

const THROTTLE_4G = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8, // 1.6 Mbps
  uploadThroughput: (750 * 1024) / 8, // 750 Kbps
  latency: 150, // 150ms RTT
};

const CPU_SLOWDOWN = 2; // 2× CPU throttle (modern budget phone)

async function measureLCP(
  page: import("@playwright/test").Page,
  url: string,
): Promise<number> {
  const cdp = await page.context().newCDPSession(page);

  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", THROTTLE_4G);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(3000);

  const lcpResult = await page.evaluate(() => {
    return new Promise<{ startTime: number; element: string; url: string; size: number }>(
      (resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1] as PerformanceEntry & {
            element?: Element;
            url?: string;
            size?: number;
          };
          resolve({
            startTime: last.startTime,
            element: last.element?.tagName ?? "unknown",
            url: last.url ?? "",
            size: last.size ?? 0,
          });
        }).observe({ type: "largest-contentful-paint", buffered: true });
        setTimeout(
          () =>
            resolve({ startTime: -1, element: "timeout", url: "", size: 0 }),
          5000,
        );
      },
    );
  });
  const lcp = lcpResult.startTime;
  console.log(
    `  LCP element: <${lcpResult.element}> size=${lcpResult.size} url=${lcpResult.url.slice(0, 120)}`,
  );

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

test.describe("LCP measurement (real images, throttled 4G)", () => {
  test.describe.configure({ retries: 1 });
  for (const [name, path] of [["home", "/"], ["product", "/listings/mn_egusi"]]) {
    test(`${name} page LCP under 2.5s`, async ({ page }, testInfo) => {
      const lcp = await measureLCP(page, `${BASE}${path}`);
      const result = { page: name, lcpMs: lcp, network: "1.6Mbps down / 750Kbps up / 150ms RTT", cpuSlowdown: CPU_SLOWDOWN, browserCache: "disabled", imageStubs: false };
      console.log(JSON.stringify(result));
      await testInfo.attach(`${name}-lcp.json`, { body: JSON.stringify(result, null, 2), contentType: "application/json" });
      expect(lcp).toBeGreaterThan(0);
      expect(lcp).toBeLessThan(2500);
    });
  }
});
