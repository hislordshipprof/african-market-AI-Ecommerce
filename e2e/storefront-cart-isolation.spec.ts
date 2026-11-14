import { chromium, expect, test } from "@playwright/test";
import { readCartLines } from "./listing-db";
import { E2E_PORT, storeUrl } from "./urls";

test("store carts remain separate during pending recovery and navigation", async ({ page }) => {
  test.setTimeout(90_000);
  const mama = storeUrl("mama-ngozi");
  const tante = storeUrl("tante-marie");

  await page.goto(`${mama}/categories/grains-and-flours`);
  const card = page.getByTestId("listing-card").filter({ hasText: "Yellow Garri" }).first();
  await card.getByTestId("quick-add-btn").click();
  await expect(card.getByTestId("stepper-qty")).toHaveText("1");
  await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden({ timeout: 20_000 });
  const mamaCart = (await page.context().cookies()).find((cookie) => cookie.name === "cart_id" && cookie.domain.includes("mama-ngozi"))?.value
    ?? (await page.context().cookies()).find((cookie) => cookie.name === "cart_id")?.value;
  if (!mamaCart) throw new Error("mama cart cookie missing");

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!held && request.method() === "POST" && request.headers()["next-action"]) {
      held = true;
      await gate;
    }
    try {
      await route.continue();
    } catch {
      /* navigation closed the request */
    }
  });
  await card.getByTestId("stepper-plus").click();
  await expect.poll(() => held).toBe(true);

  await page.goto(`${tante}/categories/grains-and-flours`);
  await expect(page.getByTestId("store-name")).toHaveText("Tante Marie Caribbean Grocer");
  const tanteCard = page.getByTestId("listing-card").filter({ hasText: "Yellow Garri" }).first();
  await expect(tanteCard.getByTestId("quick-add-btn")).toBeVisible();
  await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("0");
  release();
  await expect(tanteCard.getByTestId("quick-add-btn")).toBeVisible();

  const mamaLines = await readCartLines("mama-ngozi", mamaCart);
  expect(mamaLines.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBeGreaterThanOrEqual(1);

  await page.goto(`${storeUrl()}/?store=mama-ngozi`);
  await expect(page.getByTestId("store-name")).toHaveText("Mama Ngozi African Market");
  await page.goto(`${storeUrl()}/categories/grains-and-flours`);
  const sameOrigin = page.getByTestId("listing-card").filter({ hasText: "Yellow Garri" }).first();
  await sameOrigin.getByTestId("quick-add-btn").click();
  await expect(sameOrigin.getByTestId("stepper-qty")).toHaveText("1");
  let releaseSame: () => void = () => {};
  const sameGate = new Promise<void>((resolve) => {
    releaseSame = resolve;
  });
  let heldSame = false;
  await page.unroute("**/*");
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!heldSame && request.method() === "POST" && request.headers()["next-action"]) {
      heldSame = true;
      await sameGate;
    }
    try {
      await route.continue();
    } catch {
      /* navigation closed the request */
    }
  });
  await sameOrigin.getByTestId("stepper-plus").click();
  await expect.poll(() => heldSame).toBe(true);
  await page.goto(`${storeUrl()}/?store=tante-marie`);
  await expect(page.getByTestId("store-name")).toHaveText("Tante Marie Caribbean Grocer");
  await page.goto(`${storeUrl()}/categories/grains-and-flours`);
  const switched = page.getByTestId("listing-card").filter({ hasText: "Yellow Garri" }).first();
  await expect(switched.getByTestId("quick-add-btn")).toBeVisible();
  await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("0");
  releaseSame();
  await expect(switched.getByTestId("quick-add-btn")).toBeVisible();
  await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("0");
});

test("same-document store switch keeps both carts and drops the other store's pending recovery", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${storeUrl()}/?store=mama-ngozi`);
  await page.goto(`${storeUrl()}/categories/grains-and-flours`);
  const mamaCard = page.getByTestId("listing-card").filter({ hasText: "Yellow Garri" }).first();
  await mamaCard.getByTestId("quick-add-btn").click();
  await expect(mamaCard.getByTestId("stepper-qty")).toHaveText("1");
  await expect(page.getByTestId("storefront-header").locator("[data-cart-pending]")).toBeHidden({ timeout: 20_000 });
  const mamaCart = (await page.context().cookies()).find((cookie) => cookie.name === "cart_id")?.value;
  if (!mamaCart) throw new Error("mama cart cookie missing");
  const mamaBefore = await readCartLines("mama-ngozi", mamaCart);
  expect(mamaBefore.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(1);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!held && request.method() === "POST" && request.headers()["next-action"]) {
      held = true;
      await gate;
    }
    try {
      await route.continue();
    } catch {
      /* the document navigated */
    }
  });
  await mamaCard.getByTestId("stepper-plus").click();
  await expect.poll(() => held).toBe(true);

  await page.evaluate(() => {
    (window as unknown as { __sameDoc?: number }).__sameDoc = 1;
  });
  await page.context().addCookies([
    {
      name: "store_override",
      value: "tante-marie",
      domain: "localhost",
      path: "/",
    },
  ]);
  await page.getByRole("link", { name: "Mama Ngozi African Market" }).click();
  await expect(page.getByTestId("store-name")).toHaveText("Tante Marie Caribbean Grocer");
  expect(await page.evaluate(() => (window as unknown as { __sameDoc?: number }).__sameDoc)).toBe(1);
  await page.getByRole("link", { name: "Grains & Flours" }).first().click();
  const tanteCard = page.getByTestId("listing-card").filter({ hasText: "Yellow Garri" }).first();
  await expect(tanteCard.getByTestId("quick-add-btn")).toBeVisible();
  release();
  await expect(tanteCard.getByTestId("quick-add-btn")).toBeVisible();
  await page.unroute("**/*");
  await tanteCard.getByTestId("quick-add-btn").click();
  await expect(tanteCard.getByTestId("stepper-qty")).toHaveText("1");
  await expect.poll(async () => {
    const tanteCart = (await page.context().cookies()).find(
      (cookie) => cookie.name === "cart_id" && cookie.domain === "localhost",
    )?.value;
    if (!tanteCart || tanteCart === mamaCart) return 0;
    const lines = await readCartLines("tante-marie", tanteCart);
    return lines.find((line) => line.listingId === "tm_garri_yellow")?.qty ?? 0;
  }, { timeout: 15_000 }).toBe(1);
  const mamaLines = await readCartLines("mama-ngozi", mamaCart);
  expect(mamaLines.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBeGreaterThanOrEqual(1);
  await expect(tanteCard.getByTestId("stepper-qty")).toHaveText("1");
});

test("an http custom host keeps the cart after add and reload", async () => {
  test.setTimeout(90_000);
  const host = "mama-ngozi.example.test";
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${host} 127.0.0.1`] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://${host}:${E2E_PORT}/categories/grains-and-flours`);
    const card = page.getByTestId("listing-card").filter({ hasText: "Yellow Garri" }).first();
    await card.getByTestId("quick-add-btn").click();
    await expect(card.getByTestId("stepper-qty")).toHaveText("1");
    const header = page.getByTestId("storefront-header");
    await expect(header.locator("[data-cart-pending]")).toBeHidden({ timeout: 20_000 });

    const cookie = (await page.context().cookies()).find((c) => c.name === "cart_id");
    expect(cookie).toBeDefined();
    expect(cookie!.secure).toBe(false);
    expect(cookie!.domain).toBe(host);
    await expect(header.getByTestId("cart-count")).toHaveText("1");

    await page.reload();
    await expect(header.getByTestId("cart-count")).toHaveText("1");
    await header.getByRole("button", { name: "Shopping cart" }).click();
    await expect(page.getByRole("button", { name: /^Remove .*Garri.* from cart$/ })).toBeVisible();
  } finally {
    await browser.close();
  }
});
