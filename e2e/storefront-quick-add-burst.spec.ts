import { spawn, type ChildProcess } from "node:child_process";
import { expect, test, type Locator, type Page, type Request, type Route } from "@playwright/test";
import {
  deleteCartLine,
  readCartLines,
  readListingStock,
  storeIdentity,
  writeCartLine,
  writeListingStock,
  type ListingStock,
} from "./listing-db";
import { storeUrl } from "./urls";

/**
 * Same-render stepper bursts. E16, E17 and E18 do not apply: this path has
 * no time, provider-key or payment logic. E19 is the newer-intent recovery test.
 */
const base = storeUrl("mama-ngozi");
const grains = `${base}/categories/grains-and-flours`;
const spices = `${base}/categories/spices-and-seasonings`;

function garri(page: Page) {
  return page.getByTestId("listing-card").filter({ hasText: "Yellow Garri" }).first();
}
function whiteGarri(page: Page) {
  return page.getByTestId("listing-card").filter({ hasText: "White Garri" }).first();
}
function curry(page: Page) {
  return page.getByTestId("listing-card").filter({ hasText: "Curry Powder" }).first();
}
function thyme(page: Page) {
  return page.getByTestId("listing-card").filter({ hasText: "Thyme" }).first();
}
function pending(page: Page) {
  return page.getByTestId("storefront-header").locator("[data-cart-pending]");
}
function cartCount(page: Page) {
  return page.getByTestId("storefront-header").getByTestId("cart-count");
}
function isAction(request: Request) {
  return request.method() === "POST" && request.headers()["next-action"] !== undefined;
}
function quantitiesIn(body: string) {
  return [...body.matchAll(/,(\d+)(?=[,\]])/g)].map((match) => Number(match[1]));
}
function looksLikeRead(body: string) {
  if (quantitiesIn(body).length > 0) return false;
  if (body.includes("named_substitute") || body.includes("store_suggests") || body.includes("exact_only")) {
    return false;
  }
  // A removal posts only a line id. That is not a cart read.
  if (/"[^"]+"/.test(body)) return false;
  return true;
}

/** Node has no hosts entry for *.localhost, so the real request is fetched by IP with the original Host. */
async function fetchAction(route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  const host = url.host;
  url.hostname = "127.0.0.1";
  return route.fetch({
    url: url.toString(),
    headers: { ...request.headers(), host },
  });
}

async function deferRemoval(page: Page) {
  await page.evaluate(() => {
    const win = window as Window & {
      __e2eRemovalResult?: () => Promise<{ ok: false; error: string; code: string }>;
      __releaseE2ERemoval?: (result: { ok: false; error: string; code: string }) => void;
    };
    win.__e2eRemovalResult = () =>
      new Promise((resolve) => {
        win.__releaseE2ERemoval = resolve;
      });
  });
}

async function releaseRemoval(page: Page) {
  await page.evaluate(() => {
    (window as Window & {
      __releaseE2ERemoval?: (result: { ok: false; error: string; code: string }) => void;
    }).__releaseE2ERemoval?.({
      ok: false,
      error: "Please sign in again.",
      code: "USER_NOT_FOUND",
    });
  });
}

async function burst(locator: Locator, times: number) {
  await locator.evaluate((el, n) => {
    const button = el as HTMLButtonElement;
    for (let i = 0; i < Number(n); i++) button.click();
  }, times);
}

async function settle(page: Page) {
  await expect(pending(page)).toBeHidden({ timeout: 20_000 });
}

async function expectNoCrash(page: Page) {
  await expect(page.getByRole("heading", { name: "The market could not load" })).toHaveCount(0);
}

async function cartCookie(page: Page) {
  const cookies = await page.context().cookies();
  const cookie = cookies.find((item) => item.name === "cart_id");
  if (!cookie) throw new Error("cart cookie missing");
  return cookie.value;
}

async function openGrains(page: Page) {
  await page.goto(grains);
  await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
}

async function addGarri(page: Page) {
  await garri(page).getByTestId("quick-add-btn").click();
  await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
  await settle(page);
}

async function revalidateMama(page: Page) {
  const store = await storeIdentity("mama-ngozi");
  const secret = process.env.STOREFRONT_REVALIDATION_SECRET ?? "e2e-storefront-revalidate";
  const response = await page.request.post(`${storeUrl()}/api/storefront/revalidate`, {
    headers: { authorization: `Bearer ${secret}` },
    data: { stores: [{ id: store.id, slug: store.slug }] },
  });
  expect(response.status()).toBe(200);
}

test.describe("same-render quick add", () => {
  test("two plus clicks in one task add two", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await burst(garri(page).getByTestId("stepper-plus"), 2);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
    await expect(cartCount(page)).toHaveText("3");
    await settle(page);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
    await expect(cartCount(page)).toHaveText("3");
  });

  test("two minus clicks in one task remove two", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await garri(page).getByTestId("stepper-plus").click();
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    await burst(garri(page).getByTestId("stepper-minus"), 2);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await expect(cartCount(page)).toHaveText("1");
    await settle(page);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
  });

  test("two minus clicks from two remove the line once", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    const removes: string[] = [];
    page.on("request", (request) => {
      if (!isAction(request)) return;
      const body = request.postData() ?? "";
      if (quantitiesIn(body).length === 0 && body.includes('"')) removes.push(body);
    });
    await burst(garri(page).getByTestId("stepper-minus"), 2);
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await settle(page);
    expect(removes.length).toBe(1);
    await page.reload();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await expect(cartCount(page)).toHaveText("0");
  });

  test("a double-click adds two", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await garri(page).getByTestId("stepper-plus").dblclick();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
  });

  test("a dropped quantity request leaves the store usable and matches the server", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    let dropped = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (!dropped && isAction(request) && quantitiesIn(request.postData() ?? "").length > 0) {
        dropped = true;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expectNoCrash(page);
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
    await expect(garri(page).getByTestId("stepper-plus")).toBeEnabled();
    await settle(page);
    await page.unroute("**/*");
    const shown = (await garri(page).getByTestId("stepper-qty").innerText()).trim();
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText(shown);
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText(String(Number(shown) + 1));
    await settle(page);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText(String(Number(shown) + 1));
  });
});

test.describe("quick add limits and recovery", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let curryStock: ListingStock;
  let thymeStock: ListingStock;

  test.beforeAll(async () => {
    curryStock = await readListingStock("mama-ngozi", "mn_curry");
    thymeStock = await readListingStock("mama-ngozi", "mn_thyme");
  });

  test.afterAll(async () => {
    if (curryStock) await writeListingStock("mama-ngozi", "mn_curry", curryStock);
    if (thymeStock) await writeListingStock("mama-ngozi", "mn_thyme", thymeStock);
    const store = await storeIdentity("mama-ngozi");
    const port = process.env.E2E_PORT || "3000";
    await fetch(`http://127.0.0.1:${port}/api/storefront/revalidate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.STOREFRONT_REVALIDATION_SECRET ?? "e2e-storefront-revalidate"}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ stores: [{ id: store.id, slug: store.slug }] }),
    }).catch(() => undefined);
  });

  test("a burst past the listing max ends at the max the server allows", async ({ page }) => {
    await writeListingStock("mama-ngozi", "mn_curry", { ...curryStock, maxPerOrder: 3 });
    await page.goto(spices);
    await curry(page).getByTestId("quick-add-btn").click();
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await burst(curry(page).getByTestId("stepper-plus"), 4);
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Maximum 3 per order for this item" }).first()).toBeVisible();
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("3");
    await expect(cartCount(page)).toHaveText("3");
    await settle(page);
    await page.reload();
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("3");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.listingId === "mn_curry")?.qty).toBe(3);
  });

  test("first-add burst respects a server-only maximum", async ({ page }) => {
    await writeListingStock("mama-ngozi", "mn_curry", { ...curryStock, maxPerOrder: 3 });
    await page.goto(spices);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && quantitiesIn(body).includes(1) && body.includes("mn_curry")) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    await curry(page).getByTestId("quick-add-btn").click();
    await expect.poll(() => held).toBe(true);
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("1");
    await burst(curry(page).getByTestId("stepper-plus"), 4);
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("5");
    release();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Maximum 3 per order for this item" }).first()).toBeVisible();
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    await page.reload();
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("3");
  });

  test("a burst at 99 stops at 99 and never sends 100", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    let shown = 1;
    while (shown < 97) {
      const step = Math.min(10, 97 - shown);
      await burst(garri(page).getByTestId("stepper-plus"), step);
      shown += step;
      await expect(garri(page).getByTestId("stepper-qty")).toHaveText(String(shown), { timeout: 30_000 });
      await settle(page);
    }
    const bodies: string[] = [];
    page.on("request", (request) => {
      if (isAction(request)) bodies.push(request.postData() ?? "");
    });
    await burst(garri(page).getByTestId("stepper-plus"), 3);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("99");
    await expect(garri(page).getByTestId("stepper-plus")).toBeDisabled();
    await settle(page);
    const numbers = bodies.flatMap(quantitiesIn);
    expect(numbers).not.toContain(100);
    expect(numbers.filter((qty) => qty === 99)).toHaveLength(1);
    const before = bodies.length;
    await garri(page).getByTestId("stepper-plus").evaluate((el) => {
      const button = el as HTMLButtonElement;
      button.disabled = false;
      button.click();
    });
    await settle(page);
    expect(bodies.length).toBe(before);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("99");
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("99");
  });

  test("zero and upper-limit no-ops dispatch no extra mutations", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    const bodies: string[] = [];
    page.on("request", (request) => {
      if (isAction(request)) bodies.push(request.postData() ?? "");
    });
    await burst(garri(page).getByTestId("stepper-minus"), 2);
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await settle(page);
    const removes = bodies.filter((body) => quantitiesIn(body).length === 0 && body.includes('"'));
    expect(removes).toHaveLength(1);
    await page.reload();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
  });

  test("clicks while the first add is in flight all count", async ({ page }) => {
    await openGrains(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes("mn_garri_y_v1") && quantitiesIn(body).includes(1)) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect.poll(() => held).toBe(true);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await burst(garri(page).getByTestId("stepper-plus"), 5);
    await page.waitForTimeout(1500);
    release();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("6");
    await settle(page);
    await garri(page).getByTestId("stepper-plus").click();
    await garri(page).getByTestId("stepper-plus").click();
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("9");
    await expect(cartCount(page)).toHaveText("9");
    await settle(page);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("9");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(9);
    expect(lines.find((line) => line.listingId === "mn_garri_yellow")?.id).toBeTruthy();
  });

  test("a lost response after the server saved the step shows the saved quantity", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const id = await cartCookie(page);
    let phase: "loss" | "done" = "loss";
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (phase === "loss" && isAction(request) && quantitiesIn(body).includes(2)) {
        phase = "done";
        const url = new URL(request.url());
        const host = url.host;
        url.hostname = "127.0.0.1";
        const response = await route.fetch({
          url: url.toString(),
          headers: { ...request.headers(), host },
        });
        expect(response.status()).toBe(200);
        const text = await response.text();
        expect(text).not.toContain("Maximum");
        const lines = await readCartLines("mama-ngozi", id);
        expect(lines.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(2);
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expectNoCrash(page);
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
    await settle(page);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(2);
  });

  test("a click during cart readback survives the older snapshot", async ({ page }) => {
    await test.step("initialization", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = false;
      await page.route("**/*", async (route) => {
        const request = route.request();
        const body = request.postData() ?? "";
        if (!held && isAction(request) && looksLikeRead(body)) {
          held = true;
          const response = await fetchAction(route);
          await gate;
          await route.fulfill({ response });
          return;
        }
        await route.continue();
      });
      await page.goto(grains);
      await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
      await expect.poll(() => held).toBe(true);
      await garri(page).getByTestId("quick-add-btn").click();
      await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
      release();
      await settle(page);
      await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
      await page.unroute("**/*");
      await page.reload();
      await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    });

    await test.step("error recovery", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let dropped = false;
      let heldRead: Route | null = null;
      await page.route("**/*", async (route) => {
        const request = route.request();
        const body = request.postData() ?? "";
        if (!dropped && isAction(request) && quantitiesIn(body).length > 0) {
          dropped = true;
          await route.abort("failed");
          return;
        }
        if (dropped && !heldRead && isAction(request) && looksLikeRead(body)) {
          heldRead = route;
          const response = await fetchAction(route);
          await gate;
          await route.fulfill({ response });
          return;
        }
        await route.continue();
      });
      await garri(page).getByTestId("stepper-plus").click();
      await expect.poll(() => heldRead !== null).toBe(true);
      await garri(page).getByTestId("stepper-plus").click();
      release();
      await expectNoCrash(page);
      await settle(page);
      await page.reload();
      await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
    });
  });

  test("remove after a burst leaves no line", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await burst(garri(page).getByTestId("stepper-plus"), 3);
    await page.getByRole("button", { name: "Shopping cart" }).click();
    await page.getByRole("button", { name: "Remove Yellow Garri (Ijebu) from cart" }).click();
    await settle(page);
    await expect(page.getByRole("dialog", { name: "Your cart" })).not.toContainText("Yellow Garri");
    await page.reload();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await expect(cartCount(page)).toHaveText("0");
  });

  test("a burst on one line leaves other lines and the subtotal correct", async ({ page }) => {
    await page.goto(`${base}/listings/mn_garri_yellow`);
    const detail = page.getByTestId("product-detail");
    await detail.getByTestId("quick-add-btn").click();
    await expect(detail.getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await detail.getByTestId("pack-option").filter({ hasText: "5 lb bag" }).click();
    await detail.getByTestId("quick-add-btn").click();
    await expect(detail.getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (!held && isAction(request) && quantitiesIn(request.postData() ?? "").length > 0) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    await detail.getByTestId("stepper-plus").click();
    await expect.poll(() => held).toBe(true);
    await detail.getByTestId("pack-option").filter({ hasText: "1 lb" }).click();
    await detail.getByTestId("stepper-plus").click();
    release();
    await settle(page);
    await page.goto(`${base}/cart`);
    const bag = page.getByRole("listitem").filter({ hasText: "5 lb bag" });
    const pound = page.getByRole("listitem").filter({ hasText: "1 lb" });
    await expect(bag.getByTestId("stepper-qty")).toHaveText("2");
    await expect(pound.getByTestId("stepper-qty")).toHaveText("2");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    const cents = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    expect(cents).toBe(2 * 699 + 2 * 2999);
    await expect(page.locator(".flow-fee", { hasText: "Subtotal" }).getByLabel("$73.96")).toBeVisible();
    await page.reload();
    await expect(bag.getByTestId("stepper-qty")).toHaveText("2");
    await expect(pound.getByTestId("stepper-qty")).toHaveText("2");
    await expect(page.locator(".flow-fee", { hasText: "Subtotal" }).getByLabel("$73.96")).toBeVisible();
  });

  test("overlapping first adds and pack changes preserve both intents", async ({ page }) => {
    await openGrains(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let yellowHeld = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes("mn_garri_w_v1")) {
        await route.abort("failed");
        return;
      }
      if (!yellowHeld && isAction(request) && body.includes("mn_garri_y_v1")) {
        yellowHeld = true;
        await gate;
      }
      await route.continue();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect.poll(() => yellowHeld).toBe(true);
    release();
    await expectNoCrash(page);
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
    await settle(page);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await expect(whiteGarri(page).getByTestId("quick-add-btn")).toBeVisible();
    await page.unroute("**/*");
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines).toHaveLength(2);
    const cents = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    await page.goto(`${base}/cart`);
    await expect(page.locator(".flow-fee", { hasText: "Subtotal" }).getByLabel(`$${(cents / 100).toFixed(2)}`)).toBeVisible();
  });

  test("failed first add and failed add readback recover for the next click", async ({ page }) => {
    await test.step("add fails before the server keeps a line", async () => {
      await openGrains(page);
      await page.route("**/*", async (route) => {
        const request = route.request();
        const body = request.postData() ?? "";
        if (isAction(request) && body.includes("mn_garri_y_v1")) {
          await route.abort("failed");
          return;
        }
        await route.continue();
      });
      await garri(page).getByTestId("quick-add-btn").click();
      await expectNoCrash(page);
      await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
      await settle(page);
      await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
      await expect(page.getByTestId("storefront-header").locator("[data-cart-attention]")).toBeVisible();
      await page.unroute("**/*");
      await garri(page).getByTestId("quick-add-btn").click();
      await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
      await settle(page);
    });

    await test.step("saved first add whose read fails keeps the next click", async () => {
      let phase: "add" | "read" | "done" = "add";
      await page.route("**/*", async (route) => {
        const request = route.request();
        const body = request.postData() ?? "";
        if (phase === "add" && isAction(request) && body.includes("mn_garri_w_v1")) {
          phase = "read";
          await route.continue();
          return;
        }
        if (phase === "read" && isAction(request) && looksLikeRead(body)) {
          phase = "done";
          await route.abort("failed");
          return;
        }
        await route.continue();
      });
      await whiteGarri(page).getByTestId("quick-add-btn").click();
      await expectNoCrash(page);
      await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
      await settle(page);
      await page.unroute("**/*");
      await whiteGarri(page).getByTestId("stepper-plus").click();
      await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
      await settle(page);
      await page.reload();
      await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
      await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
      const lines = await readCartLines("mama-ngozi", await cartCookie(page));
      const white = lines.filter((line) => line.variantId === "mn_garri_w_v1");
      expect(white).toHaveLength(1);
      expect(white[0]?.qty).toBe(2);
    });
  });

  test("a failed recovery read stays recoverable and later resynchronizes", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await page.route("**/*", async (route) => {
      if (isAction(route.request())) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expectNoCrash(page);
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
    await expect(page.getByTestId("storefront-header").locator("[data-cart-attention]")).toBeVisible();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await page.unroute("**/*");
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    await expect(page.getByTestId("storefront-header").locator("[data-cart-attention]")).toHaveCount(0);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
  });

  test("remove and re-add across an in-flight add or delete use the surviving row", async ({ page }) => {
    await openGrains(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes("mn_garri_y_v1")) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect.poll(() => held).toBe(true);
    await burst(garri(page).getByTestId("stepper-minus"), 1);
    await garri(page).getByTestId("quick-add-btn").click();
    await garri(page).getByTestId("stepper-plus").click();
    release();
    await settle(page);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    const garriLines = lines.filter((line) => line.listingId === "mn_garri_yellow");
    expect(garriLines).toHaveLength(1);
    expect(garriLines[0]?.qty).toBe(2);
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
  });

  test("swap refresh preserves a newer quantity and named substitute", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await page.goto(`${base}/cart`);
    await page.getByRole("button", { name: /Replace with/ }).click();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && looksLikeRead(body)) {
        held = true;
        const response = await fetchAction(route);
        await gate;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });
    await page.getByRole("button").filter({ hasText: "White Garri" }).first().click();
    await expect.poll(() => held).toBe(true);
    const cartMain = page.locator("main");
    await cartMain.getByTestId("stepper-plus").click();
    release();
    await expect(cartMain.getByRole("button", { name: /Replace with White Garri/ })).toBeVisible();
    await expect(cartMain.getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    await page.reload();
    await expect(cartMain.getByRole("button", { name: /Replace with White Garri/ })).toBeVisible();
    await expect(cartMain.getByTestId("stepper-qty")).toHaveText("2");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(2);
  });

  test("an unavailable quantity-three line decrements to two", async ({ page }) => {
    await writeListingStock("mama-ngozi", "mn_thyme", {
      ...thymeStock,
      stockMode: "status",
      status: "in_stock",
      qty: null,
    });
    await revalidateMama(page);
    await page.goto(spices);
    await thyme(page).getByTestId("quick-add-btn").click();
    await expect(thyme(page).getByTestId("stepper-qty")).toHaveText("1");
    await thyme(page).getByTestId("stepper-plus").click();
    await thyme(page).getByTestId("stepper-plus").click();
    await expect(thyme(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    await writeListingStock("mama-ngozi", "mn_thyme", {
      ...thymeStock,
      stockMode: "status",
      status: "out_of_stock",
      qty: null,
    });
    await revalidateMama(page);
    await page.goto(`${base}/cart`);
    await expect(page.getByText("Unavailable. Remove this item before checkout.")).toBeVisible();
    const line = page.getByRole("listitem").filter({ hasText: "Thyme" });
    await expect(line.getByTestId("stepper-qty")).toHaveText("3");
    await line.getByTestId("stepper-minus").click();
    await expect(line.getByTestId("stepper-qty")).toHaveText("2");
    await line.getByTestId("stepper-plus").evaluate((el) => {
      const button = el as HTMLButtonElement;
      button.disabled = false;
      button.click();
    });
    await expect(line.getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    await page.reload();
    await expect(page.getByRole("listitem").filter({ hasText: "Thyme" }).getByTestId("stepper-qty")).toHaveText("2");
  });

  test("an unavailable line on the cart page can go down but not up", async ({ page }) => {
    await writeListingStock("mama-ngozi", "mn_thyme", thymeStock);
    await revalidateMama(page);
    await page.goto(spices);
    await thyme(page).getByTestId("quick-add-btn").click();
    await thyme(page).getByTestId("stepper-plus").click();
    await expect(thyme(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    await writeListingStock("mama-ngozi", "mn_thyme", {
      ...thymeStock,
      stockMode: "status",
      status: "out_of_stock",
      qty: null,
    });
    await revalidateMama(page);
    await page.goto(`${base}/cart`);
    const line = page.locator("main").getByRole("listitem").filter({ hasText: "Thyme" });
    await expect(line.getByText("Unavailable. Remove this item before checkout.")).toBeVisible();
    await expect(line.getByTestId("stepper-qty")).toHaveText("2");
    await expect(line.getByTestId("stepper-plus")).toBeDisabled();
    await line.getByTestId("stepper-minus").click();
    await expect(line.getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await page.reload();
    await expect(page.locator("main").getByRole("listitem").filter({ hasText: "Thyme" }).getByTestId("stepper-qty")).toHaveText("1");
  });

  test("a saved first add shows after reload when the cart cookie reached this host", async ({ page }) => {
    await openGrains(page);
    let setCookie = "";
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!setCookie && isAction(request) && body.includes("mn_garri_y_v1")) {
        const response = await fetchAction(route);
        expect(response.status()).toBe(200);
        const text = await response.text();
        expect(text).not.toContain("Maximum");
        setCookie = response.headers()["set-cookie"] ?? "";
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expectNoCrash(page);
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
    const match = /cart_id=([^;]+)/.exec(setCookie);
    expect(match?.[1]).toBeTruthy();
    const saved = await readCartLines("mama-ngozi", match![1]);
    expect(saved.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(1);
    // route.fetch stores the cookie on 127.0.0.1. A dropped response does not
    // deliver it to the store host. Plant the cookie the browser would have
    // kept if the response headers had arrived on this host.
    await page.unroute("**/*");
    await page.context().addCookies([
      {
        name: "cart_id",
        value: match![1],
        domain: "mama-ngozi.localhost",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await expect(cartCount(page)).toHaveText("1");
    await page.goto(`${base}/cart`);
    await expect(page.locator("main").getByRole("heading", { name: "Your basket" })).toBeVisible();
    await expect(page.locator("main")).toContainText("1 item from");
    await expect(page.locator("main").getByText("Yellow Garri")).toBeVisible();
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(1);
  });

  test("a decrement the server still rejects stays at the saved quantity", async ({ page }) => {
    await writeListingStock("mama-ngozi", "mn_curry", { ...curryStock, maxPerOrder: null });
    await page.goto(spices);
    await curry(page).getByTestId("quick-add-btn").click();
    await curry(page).getByTestId("stepper-plus").click();
    await curry(page).getByTestId("stepper-plus").click();
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    await writeListingStock("mama-ngozi", "mn_curry", { ...curryStock, maxPerOrder: 1 });
    await curry(page).getByTestId("stepper-minus").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Maximum 1 per order for this item" }).first()).toBeVisible();
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    await page.reload();
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("3");
  });

  test("a rejected decrement keeps another line's queued plus", async ({ page }) => {
    await writeListingStock("mama-ngozi", "mn_curry", { ...curryStock, maxPerOrder: null });
    await page.goto(spices);
    await curry(page).getByTestId("quick-add-btn").click();
    await curry(page).getByTestId("stepper-plus").click();
    await curry(page).getByTestId("stepper-plus").click();
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    await page.goto(grains);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await writeListingStock("mama-ngozi", "mn_curry", { ...curryStock, maxPerOrder: 1 });
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const curryLine = before.find((line) => line.listingId === "mn_curry");
    expect(curryLine?.qty).toBe(3);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes(curryLine!.id) && quantitiesIn(body).includes(2)) {
        held = true;
        await gate;
      }
      await route.fallback();
    });
    await page.getByTestId("storefront-header").getByRole("button", { name: "Shopping cart" }).click();
    const sheet = page.getByRole("dialog", { name: "Your cart" });
    await sheet.getByRole("listitem").filter({ hasText: "Curry Powder" }).getByTestId("stepper-minus").click();
    await expect.poll(() => held).toBe(true);
    await sheet.getByRole("listitem").filter({ hasText: "White Garri" }).getByTestId("stepper-plus").click();
    await expect(sheet.getByRole("listitem").filter({ hasText: "White Garri" }).getByTestId("stepper-qty")).toHaveText("2");
    release();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Maximum 1 per order for this item" }).first()).toBeVisible();
    await expect(sheet.getByRole("listitem").filter({ hasText: "Curry Powder" }).getByTestId("stepper-qty")).toHaveText("3");
    await expect(sheet.getByRole("listitem").filter({ hasText: "White Garri" }).getByTestId("stepper-qty")).toHaveText("2");
    await expect(cartCount(page)).toHaveText("5");
    await settle(page);
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    const cents = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const label = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
    await expect(sheet.getByText(label).first()).toBeVisible();
    expect(lines.find((line) => line.listingId === "mn_curry")?.qty).toBe(3);
    expect(lines.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
    await page.reload();
    await expect(cartCount(page)).toHaveText("5");
    const after = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(after.find((line) => line.listingId === "mn_curry")?.qty).toBe(3);
    expect(after.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
  });

  test("a newer click on the rejected line is kept with another line's queued plus", async ({ page }) => {
    await writeListingStock("mama-ngozi", "mn_curry", { ...curryStock, maxPerOrder: null });
    await page.goto(spices);
    await curry(page).getByTestId("quick-add-btn").click();
    await curry(page).getByTestId("stepper-plus").click();
    await curry(page).getByTestId("stepper-plus").click();
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    await page.goto(grains);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await writeListingStock("mama-ngozi", "mn_curry", { ...curryStock, maxPerOrder: 1 });
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const curryLine = before.find((line) => line.listingId === "mn_curry");
    expect(curryLine?.id).toBeTruthy();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes(curryLine!.id) && quantitiesIn(body).includes(2)) {
        held = true;
        await gate;
      }
      await route.fallback();
    });
    await page.getByTestId("storefront-header").getByRole("button", { name: "Shopping cart" }).click();
    const sheet = page.getByRole("dialog", { name: "Your cart" });
    const curryRow = sheet.getByRole("listitem").filter({ hasText: "Curry Powder" });
    await curryRow.getByTestId("stepper-minus").click();
    await expect.poll(() => held).toBe(true);
    await curryRow.getByTestId("stepper-minus").click();
    await expect(curryRow.getByTestId("stepper-qty")).toHaveText("1");
    await sheet.getByRole("listitem").filter({ hasText: "White Garri" }).getByTestId("stepper-plus").click();
    release();
    await settle(page);
    await expect(curryRow.getByTestId("stepper-qty")).toHaveText("1");
    await expect(sheet.getByRole("listitem").filter({ hasText: "White Garri" }).getByTestId("stepper-qty")).toHaveText("2");
    await page.reload();
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.listingId === "mn_curry")?.qty).toBe(1);
    expect(lines.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
  });

  test("a rejected decrement with failed recovery reads keeps another line's plus", async ({ page }) => {
    await writeListingStock("mama-ngozi", "mn_curry", { ...curryStock, maxPerOrder: null });
    await page.goto(spices);
    await curry(page).getByTestId("quick-add-btn").click();
    await curry(page).getByTestId("stepper-plus").click();
    await curry(page).getByTestId("stepper-plus").click();
    await expect(curry(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    await page.goto(grains);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await writeListingStock("mama-ngozi", "mn_curry", { ...curryStock, maxPerOrder: 1 });
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const curryLine = before.find((line) => line.listingId === "mn_curry");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    let released = false;
    let reads = 0;
    let curryWrites = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(curryLine!.id)) {
        curryWrites += 1;
        if (!held && quantitiesIn(body).includes(2)) {
          held = true;
          await gate;
          released = true;
          await route.fallback();
          return;
        }
      }
      if (released && isAction(request) && looksLikeRead(body)) {
        reads += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    const sheet = await openSheet(page);
    await sheet.getByRole("listitem").filter({ hasText: "Curry Powder" }).getByTestId("stepper-minus").click();
    await expect.poll(() => held).toBe(true);
    await sheet.getByRole("listitem").filter({ hasText: "White Garri" }).getByTestId("stepper-plus").click();
    await expect(sheet.getByRole("listitem").filter({ hasText: "White Garri" }).getByTestId("stepper-qty")).toHaveText("2");
    release();
    await settle(page);
    expect(reads).toBeGreaterThan(0);
    expect(curryWrites).toBe(1);
    await expect(sheet.getByRole("listitem").filter({ hasText: "Curry Powder" }).getByTestId("stepper-qty")).toHaveText("3");
    await expect(attention(page)).toBeVisible();
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.id === curryLine!.id)?.qty).toBe(3);
    expect(lines.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
  });
});

test.describe("quick add recovery gaps", () => {
  test.describe.configure({ timeout: 90_000 });

  test("a pending decrement survives another line finishing", async ({ page }) => {
    await openGrains(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await whiteGarri(page).getByTestId("stepper-plus").click();
    await whiteGarri(page).getByTestId("stepper-plus").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes("mn_garri_y_v1")) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect.poll(() => held).toBe(true);
    await whiteGarri(page).getByTestId("stepper-minus").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    release();
    await settle(page);
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    await page.reload();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
  });

  test("trash during a pending first add does not restore the line", async ({ page }) => {
    await openGrains(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes("mn_garri_y_v1")) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect.poll(() => held).toBe(true);
    await page.getByTestId("storefront-header").getByRole("button", { name: "Shopping cart" }).click();
    await page.getByRole("button", { name: "Remove Yellow Garri (Ijebu) from cart" }).click();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    release();
    await settle(page);
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await page.reload();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    const lines = await readCartLines("mama-ngozi", await cartCookie(page).catch(() => ""));
    expect(lines.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(0);
  });

  test("an established row can be removed and re-added while the remove is held", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const lineId = before.find((line) => line.listingId === "mn_garri_yellow")?.id;
    expect(lineId).toBeTruthy();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes(lineId!)) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => held).toBe(true);
    await garri(page).getByTestId("quick-add-btn").click();
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    release();
    await settle(page);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    const garriLines = lines.filter((line) => line.listingId === "mn_garri_yellow");
    expect(garriLines).toHaveLength(1);
    expect(garriLines[0]?.id).not.toBe(lineId);
    expect(garriLines[0]?.qty).toBe(2);
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
    await settle(page);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
  });

  test("a plus after a saved first add and a failed read reaches two", async ({ page }) => {
    await openGrains(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    let added = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!added && isAction(request) && body.includes("mn_garri_y_v1")) {
        added = true;
        await route.continue();
        return;
      }
      if (added && isAction(request) && looksLikeRead(body)) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
    await settle(page);
    await page.unroute("**/*");
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellow = lines.filter((line) => line.variantId === "mn_garri_y_v1");
    expect(yellow).toHaveLength(1);
    expect(yellow[0]?.qty).toBe(2);
  });

  test("a click during the first-add readback is kept", async ({ page }) => {
    await openGrains(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let added = false;
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!added && isAction(request) && body.includes("mn_garri_y_v1")) {
        added = true;
        await route.continue();
        return;
      }
      if (added && !held && isAction(request) && looksLikeRead(body)) {
        held = true;
        const response = await fetchAction(route);
        await gate;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect.poll(() => held).toBe(true);
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    release();
    await settle(page);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
  });

  test("a lost response still applies a click that was already queued", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && quantitiesIn(body).includes(2)) {
        held = true;
        const response = await fetchAction(route);
        expect(response.status()).toBe(200);
        await gate;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect.poll(() => held).toBe(true);
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
    release();
    await settle(page);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(3);
  });

  test("an unknown server action asks for a reload and a fresh page still adds", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    let actions = 0;
    let rewritten = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!isAction(request)) {
        await route.fallback();
        return;
      }
      actions += 1;
      if (quantitiesIn(body).length > 0 && rewritten === 0) {
        rewritten += 1;
        const headers = { ...request.headers(), "next-action": "a".repeat(42) };
        await route.continue({ headers });
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expectNoCrash(page);
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "This page is out of date" }).first()).toBeVisible();
    const actionsAtToast = actions;
    const qtyAtToast = await garri(page).getByTestId("stepper-qty").innerText();
    expect(rewritten).toBe(1);
    await settle(page);
    await garri(page).getByTestId("stepper-plus").click();
    await settle(page);
    await page.waitForTimeout(400);
    expect(actions).toBe(actionsAtToast);
    expect(rewritten).toBe(1);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText(qtyAtToast);
    await page.unroute("**/*");
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
  });

  test("a lost first add in an established cart is not added twice", async ({ page }) => {
    await openGrains(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const cartId = await cartCookie(page);
    let proved = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!proved && isAction(request) && body.includes("mn_garri_y_v1")) {
        const response = await fetchAction(route);
        expect(response.status()).toBe(200);
        const saved = await readCartLines("mama-ngozi", cartId);
        const yellow = saved.filter((line) => line.variantId === "mn_garri_y_v1");
        expect(yellow).toHaveLength(1);
        expect(yellow[0]?.qty).toBe(1);
        proved = true;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect.poll(() => proved).toBe(true);
    await settle(page);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    const beforePlus = await readCartLines("mama-ngozi", cartId);
    expect(beforePlus.filter((line) => line.variantId === "mn_garri_y_v1")).toHaveLength(1);
    expect(beforePlus.find((line) => line.variantId === "mn_garri_y_v1")?.qty).toBe(1);
    await page.unroute("**/*");
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellow = lines.filter((line) => line.variantId === "mn_garri_y_v1");
    expect(yellow).toHaveLength(1);
    expect(yellow[0]?.qty).toBe(2);
  });

  test("repeated write failures settle on the saved quantity", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    let writes = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && /,\d+\]/.test(body)) {
        writes += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect.poll(() => writes, { timeout: 8_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(4_000);
    expect(writes).toBeLessThan(8);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await page.unroute("**/*");
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.variantId === "mn_garri_y_v1")?.qty).toBe(1);
  });

  test("a rejected first add does not leave a phantom line", async ({ page }) => {
    await openGrains(page);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes("mn_garri_y_v1")) {
        await route.continue({
          postData: body.replaceAll("mn_garri_y_v1", "mn_no_such_variant"),
        });
        return;
      }
      await route.continue();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Variant does not belong to this store" }).first()).toBeVisible();
    await settle(page);
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("0");
    await page.unroute("**/*");
    await page.reload();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText("0");
  });

  test("a click during migration readback survives", async ({ page }) => {
    const store = await storeIdentity("mama-ngozi");
    await page.addInitScript((storeId) => {
      localStorage.setItem(
        `storefront-cart:${storeId}`,
        JSON.stringify([{ variantId: "mn_garri_w_v1", quantity: 1 }]),
      );
    }, store.id);
    let migrated = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!migrated && isAction(request) && body.includes("mn_garri_w_v1")) {
        migrated = true;
        await route.continue();
        return;
      }
      if (migrated && !held && isAction(request) && looksLikeRead(body)) {
        held = true;
        const response = await fetchAction(route);
        await gate;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });
    await page.goto(grains);
    await expect.poll(() => held, { timeout: 20_000 }).toBe(true);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await whiteGarri(page).getByTestId("stepper-plus").click();
    release();
    await settle(page);
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    await page.reload();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
  });
});

function moneyLabel(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

async function openSavedYellowCart(page: Page) {
  await settle(page);
  const cartId = await cartCookie(page);
  await expect.poll(async () => {
    const lines = await readCartLines("mama-ngozi", cartId);
    return lines.some((line) => line.listingId === "mn_garri_yellow");
  }).toBe(true);
  await page.goto(`${base}/cart`);
  await page.reload();
  return cartId;
}

async function openSheet(page: Page) {
  await page.getByTestId("storefront-header").getByRole("button", { name: "Shopping cart" }).click();
  const sheet = page.getByRole("dialog", { name: "Your cart" });
  await expect(sheet).toBeVisible();
  return sheet;
}

function attention(page: Page) {
  return page.getByTestId("storefront-header").locator("[data-cart-attention]");
}

test.describe("cart recovery after a failed write", () => {
  test.describe.configure({ timeout: 120_000 });

  test("cart recovery helpers cannot read or mutate another store's line", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const cartId = await cartCookie(page);
    const lines = await readCartLines("mama-ngozi", cartId);
    const yellow = lines.find((line) => line.listingId === "mn_garri_yellow");
    expect(yellow?.id).toBeTruthy();
    expect(await readCartLines("tante-marie", cartId)).toHaveLength(0);
    expect(await deleteCartLine("tante-marie", yellow!.id)).toBe(false);
    expect(await writeCartLine("tante-marie", yellow!.id, { qty: 9, swapRule: "store_suggests" })).toBe(false);
    const still = await readCartLines("mama-ngozi", cartId);
    expect(still.find((line) => line.id === yellow!.id)).toMatchObject({ qty: 1, swapRule: "exact_only" });
  });

  test("a failed removal shows the saved line again", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    expect(row?.qty).toBe(1);
    let aborted = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (aborted === 0 && isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        aborted += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => aborted).toBe(1);
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await expect(cartCount(page)).toHaveText("1");
    await settle(page);
    const sheet = await openSheet(page);
    await expect(sheet.getByRole("heading", { name: "Your next good meal starts here" })).toHaveCount(0);
    await expect(sheet.getByRole("heading", { name: "Yellow Garri (Ijebu)" })).toBeVisible();
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.id === row!.id)?.qty).toBe(1);
    const cents = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    await expect(sheet.getByText(moneyLabel(cents)).first()).toBeVisible();
    await expect(attention(page)).toBeVisible();
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
  });

  test("a failed trash removal shows the saved line again", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let aborted = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (aborted === 0 && isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        aborted += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    const sheet = await openSheet(page);
    await sheet.getByRole("button", { name: "Remove Yellow Garri (Ijebu) from cart" }).click();
    await expect.poll(() => aborted).toBe(1);
    await expect(sheet.getByRole("heading", { name: "Yellow Garri (Ijebu)" })).toBeVisible();
    await expect(cartCount(page)).toHaveText("1");
    await settle(page);
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.id === row!.id)?.qty).toBe(1);
    const cents = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    await expect(sheet.getByText(moneyLabel(cents)).first()).toBeVisible();
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
  });

  test("after a failed removal the next plus updates the same row", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const cartId = await openSavedYellowCart(page);
    await page.getByRole("button", { name: /Replace with/ }).click();
    await page.getByRole("button", { name: "Let the store suggest a swap" }).click();
    await expect.poll(async () => {
      const lines = await readCartLines("mama-ngozi", cartId);
      return lines.find((line) => line.listingId === "mn_garri_yellow")?.swapRule ?? "";
    }).toBe("store_suggests");
    const before = await readCartLines("mama-ngozi", cartId);
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    expect(row?.swapRule).toBe("store_suggests");
    let removals = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (removals === 0 && isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        removals += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await page.goto(grains);
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => removals).toBe(1);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await page.unroute("**/*");
    let laterRemoves = 0;
    let laterAdds = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) laterRemoves += 1;
      if (isAction(request) && body.includes("mn_garri_y_v1") && !body.includes(row!.id)) laterAdds += 1;
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    expect(laterRemoves).toBe(0);
    expect(laterAdds).toBe(0);
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    const saved = lines.find((line) => line.listingId === "mn_garri_yellow");
    expect(saved?.id).toBe(row!.id);
    expect(saved?.qty).toBe(2);
    expect(saved?.swapRule).toBe("store_suggests");
    const sheet = await openSheet(page);
    await expect(sheet.getByText("Store suggests a swap")).toBeVisible();
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    const reloaded = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(reloaded.find((line) => line.id === row!.id)).toMatchObject({
      qty: 2,
      swapRule: "store_suggests",
    });
  });

  test("a removal the server saved but whose response was lost stays removed", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const cartId = await cartCookie(page);
    const before = await readCartLines("mama-ngozi", cartId);
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let proved = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!proved && isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        await fetchAction(route);
        const saved = await readCartLines("mama-ngozi", cartId);
        expect(saved.find((line) => line.id === row!.id)).toBeUndefined();
        proved = true;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => proved).toBe(true);
    await settle(page);
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await expect(cartCount(page)).toHaveText("0");
    await page.unroute("**/*");
    let adds = 0;
    let removes = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes("mn_garri_y_v1")) adds += 1;
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) removes += 1;
      await route.fallback();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    expect(adds).toBe(1);
    expect(removes).toBe(0);
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(1);
  });

  test("a failed removal with failed recovery reads restores the last saved line", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let removals = 0;
    let reads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        removals += 1;
        await route.abort("failed");
        return;
      }
      if (removals > 0 && isAction(request) && looksLikeRead(body)) {
        reads += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await expect(attention(page)).toBeVisible();
    await settle(page);
    expect(removals).toBe(1);
    await page.unroute("**/*");
    let laterRemoves = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) laterRemoves += 1;
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    expect(laterRemoves).toBe(0);
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.id === row!.id)?.qty).toBe(2);
  });

  test("a removal that fails twice is restored twice and a later removal succeeds", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const cartId = await cartCookie(page);
    const before = await readCartLines("mama-ngozi", cartId);
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let removals = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0 && removals < 2) {
        removals += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await garri(page).getByTestId("stepper-minus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    expect(removals).toBe(2);
    await page.unroute("**/*");
    await garri(page).getByTestId("stepper-minus").click();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await settle(page);
    const lines = await readCartLines("mama-ngozi", cartId);
    expect(lines.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(0);
    await garri(page).getByTestId("quick-add-btn").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const added = await readCartLines("mama-ngozi", cartId);
    expect(added.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(1);
    expect(added.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(1);
  });

  test("a failed removal then a newer re-add ends at the newer quantity", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        held = true;
        await gate;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => held).toBe(true);
    await garri(page).getByTestId("quick-add-btn").click();
    release();
    await settle(page);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(1);
    expect(lines.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(1);
  });

  test("a rejected plus on a deleted line keeps another line's queued plus", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellow = before.find((line) => line.listingId === "mn_garri_yellow");
    expect(await deleteCartLine("mama-ngozi", yellow!.id)).toBe(true);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes(yellow!.id)) {
        held = true;
        await gate;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect.poll(() => held).toBe(true);
    await whiteGarri(page).getByTestId("stepper-plus").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    release();
    await settle(page);
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.id === yellow!.id)).toBeUndefined();
    expect(lines.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
    await page.reload();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
  });

  test("a failed removal restores confirmed quantity rather than queued quantity", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let reads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        await route.abort("failed");
        return;
      }
      if (isAction(request) && looksLikeRead(body)) {
        reads += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    const sheet = await openSheet(page);
    const rowUi = sheet.getByRole("listitem").filter({ hasText: "Yellow Garri" });
    await rowUi.evaluate((el) => {
      const plus = el.querySelector("[data-testid='stepper-plus']") as HTMLButtonElement | null;
      const trash = el.querySelector("button[aria-label$='from cart']") as HTMLButtonElement | null;
      plus?.click();
      trash?.click();
    });
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(rowUi.getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.id === row!.id)?.qty).toBe(2);
  });

  test("a committed removal with failed recovery reads is removed after the next rejected update", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const cartId = await cartCookie(page);
    const before = await readCartLines("mama-ngozi", cartId);
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let proved = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!proved && isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        await fetchAction(route);
        const saved = await readCartLines("mama-ngozi", cartId);
        expect(saved.find((line) => line.id === row!.id)).toBeUndefined();
        proved = true;
        await route.abort("failed");
        return;
      }
      if (proved && isAction(request) && looksLikeRead(body)) {
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => proved).toBe(true);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await page.unroute("**/*");
    let adds = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes("mn_garri_y_v1") && !body.includes(row!.id)) adds += 1;
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await settle(page);
    expect(adds).toBe(0);
    const lines = await readCartLines("mama-ngozi", cartId);
    expect(lines.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(0);
  });

  test("a rejected first add keeps another line's queued plus", async ({ page }) => {
    await openGrains(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes("mn_garri_y_v1")) {
        held = true;
        await gate;
        await route.continue({ postData: body.replaceAll("mn_garri_y_v1", "mn_no_such_variant") });
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect.poll(() => held).toBe(true);
    await whiteGarri(page).getByTestId("stepper-plus").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    release();
    await settle(page);
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
    expect(lines.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(0);
  });

  test("unrelated success does not clear failed-removal attention", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await expect(attention(page)).toBeVisible();
    await settle(page);
    await page.unroute("**/*");
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await expect(attention(page)).toBeVisible();
    await expect(pending(page)).toHaveCount(0);
  });

  test("unknown removal and recovery actions freeze the cart until reload", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let actions = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!isAction(request)) {
        await route.fallback();
        return;
      }
      actions += 1;
      if (body.includes(row!.id) && quantitiesIn(body).length === 0) {
        await route.continue({ headers: { ...request.headers(), "next-action": "b".repeat(42) } });
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "This page is out of date" }).first()).toBeVisible();
    const atToast = actions;
    const countAtToast = await cartCount(page).innerText();
    await garri(page).getByTestId("quick-add-btn").click();
    await settle(page);
    await page.waitForTimeout(400);
    expect(actions).toBe(atToast);
    await expect(cartCount(page)).toHaveText(countAtToast);
    await page.unroute("**/*");
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
  });

  test("authoritative empty recovery clears the old row identity", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        await page.context().clearCookies({ name: "cart_id" });
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await settle(page);
    await page.unroute("**/*");
    let updates = 0;
    let adds = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id)) updates += 1;
      if (isAction(request) && body.includes("mn_garri_y_v1")) adds += 1;
      await route.fallback();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    expect(updates).toBe(0);
    expect(adds).toBe(1);
    const saved = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(saved).toHaveLength(1);
    expect(saved.find((line) => line.variantId === "mn_garri_y_v1")?.qty).toBe(1);
  });

  test("a rejected write with failed recovery does not retry or starve another line", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellow = before.find((line) => line.listingId === "mn_garri_yellow");
    expect(await deleteCartLine("mama-ngozi", yellow!.id)).toBe(true);
    let yellowWrites = 0;
    let reads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(yellow!.id)) {
        yellowWrites += 1;
        await route.fallback();
        return;
      }
      if (yellowWrites > 0 && isAction(request) && looksLikeRead(body)) {
        reads += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await whiteGarri(page).getByTestId("stepper-plus").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    expect(yellowWrites).toBeLessThan(4);
    expect(reads).toBeGreaterThan(0);
    const lines = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(lines.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
  });

  test("reconciliation preserves a sibling pack's queued plus", async ({ page }) => {
    await page.goto(`${base}/listings/mn_garri_yellow`);
    const detail = page.getByTestId("product-detail");
    await detail.getByTestId("quick-add-btn").click();
    await expect(detail.getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await detail.getByTestId("pack-option").filter({ hasText: "5 lb bag" }).click();
    await detail.getByTestId("quick-add-btn").click();
    await expect(detail.getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const pound = before.find((line) => line.variantId === "mn_garri_y_v1");
    expect(await deleteCartLine("mama-ngozi", pound!.id)).toBe(true);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes(pound!.id)) {
        held = true;
        await gate;
      }
      await route.fallback();
    });
    await detail.getByTestId("pack-option").filter({ hasText: "1 lb" }).click();
    await detail.getByTestId("stepper-plus").click();
    await expect.poll(() => held).toBe(true);
    await detail.getByTestId("pack-option").filter({ hasText: "5 lb bag" }).click();
    await detail.getByTestId("stepper-plus").click();
    await expect(detail.getByTestId("stepper-qty")).toHaveText("2");
    release();
    await settle(page);
    const saved = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(saved.find((line) => line.id === pound!.id)).toBeUndefined();
    expect(saved.find((line) => line.variantId === "mn_garri_y_v2")?.qty).toBe(2);
  });

  test("restoration preserves a named substitute and uses live server data", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const cartId = await openSavedYellowCart(page);
    await page.getByRole("button", { name: /Replace with/ }).click();
    await page.getByRole("button").filter({ hasText: "White Garri" }).first().click();
    await expect.poll(async () => {
      const lines = await readCartLines("mama-ngozi", cartId);
      return lines.find((line) => line.listingId === "mn_garri_yellow")?.swapRule ?? "";
    }).toBe("named_substitute");
    const before = await readCartLines("mama-ngozi", cartId);
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    expect(row?.swapRule).toBe("named_substitute");
    expect(row?.substituteVariantId).toBeTruthy();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let removed = false;
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!removed && isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        removed = true;
        await route.abort("failed");
        return;
      }
      if (removed && !held && isAction(request) && looksLikeRead(body)) {
        held = true;
        expect(await writeCartLine("mama-ngozi", row!.id, { qty: 4 })).toBe(true);
        const response = await fetchAction(route);
        await gate;
        await route.fulfill({ response });
        return;
      }
      await route.fallback();
    });
    await page.goto(grains);
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => held).toBe(true);
    release();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("4");
    await settle(page);
    const sheet = await openSheet(page);
    await expect(sheet.getByText("Named substitute chosen")).toBeVisible();
    const saved = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(saved.find((line) => line.id === row!.id)).toMatchObject({
      qty: 4,
      swapRule: "named_substitute",
      substituteVariantId: row!.substituteVariantId,
    });
    await page.unroute("**/*");
    await page.getByRole("button", { name: "Close cart" }).click();
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("5");
    await settle(page);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("5");
    const after = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(after.find((line) => line.id === row!.id)).toMatchObject({
      qty: 5,
      swapRule: "named_substitute",
      substituteVariantId: row!.substituteVariantId,
    });
  });

  test("an old provider recovery cannot restore into another store", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const mamaCart = await cartCookie(page);
    const before = await readCartLines("mama-ngozi", mamaCart);
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let removed = false;
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!removed && isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        removed = true;
        await route.abort("failed");
        return;
      }
      if (removed && !held && isAction(request) && looksLikeRead(body)) {
        held = true;
        await gate;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => held).toBe(true);
    const going = page.goto(`${storeUrl("tante-marie")}/`);
    release();
    await going;
    await expect(cartCount(page)).toHaveText("0");
    await page.unroute("**/*");
    await page.goto(grains);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    expect((await readCartLines("mama-ngozi", mamaCart)).find((line) => line.id === row!.id)?.qty).toBe(1);
  });

  test("newer intent survives rejection before and during recovery", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellow = before.find((line) => line.listingId === "mn_garri_yellow");
    expect(await deleteCartLine("mama-ngozi", yellow!.id)).toBe(true);
    let releaseWrite: () => void = () => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let heldWrite = false;
    let heldRead = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!heldWrite && isAction(request) && body.includes(yellow!.id)) {
        heldWrite = true;
        await writeGate;
        await route.fallback();
        return;
      }
      if (heldWrite && !heldRead && isAction(request) && looksLikeRead(body)) {
        heldRead = true;
        const response = await fetchAction(route);
        await readGate;
        await route.fulfill({ response });
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect.poll(() => heldWrite).toBe(true);
    const sheet = await openSheet(page);
    await sheet.getByRole("button", { name: "Remove Yellow Garri (Ijebu) from cart" }).click();
    releaseWrite();
    await expect.poll(() => heldRead).toBe(true);
    await sheet.getByRole("listitem").filter({ hasText: "White Garri" }).getByTestId("stepper-plus").click();
    releaseRead();
    await settle(page);
    await page.getByRole("button", { name: "Close cart" }).click();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    const saved = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(saved.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(0);
    expect(saved.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
  });

  test("an empty server cart clears the old row identity", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let removed = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        removed = (await deleteCartLine("mama-ngozi", row!.id)) || removed;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await settle(page);
    expect(removed).toBe(true);
    await page.unroute("**/*");
    let updates = 0;
    let adds = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id)) updates += 1;
      if (isAction(request) && body.includes("mn_garri_y_v1")) adds += 1;
      await route.fallback();
    });
    await garri(page).getByTestId("quick-add-btn").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    expect(updates).toBe(0);
    expect(adds).toBe(1);
    const saved = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(saved.filter((line) => line.id === row!.id)).toHaveLength(0);
    expect(saved).toHaveLength(1);
    expect(saved.find((line) => line.variantId === "mn_garri_y_v1")?.qty).toBe(1);
  });

  test("a stale recovery read freezes the cart until reload", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let actions = 0;
    let reads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!isAction(request)) {
        await route.fallback();
        return;
      }
      actions += 1;
      if (body.includes(row!.id) && quantitiesIn(body).length === 0) {
        await route.abort("failed");
        return;
      }
      if (looksLikeRead(body)) {
        reads += 1;
        if (reads === 1) {
          await route.abort("failed");
          return;
        }
        await route.continue({ headers: { ...request.headers(), "next-action": "c".repeat(42) } });
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "This page is out of date" }).first()).toBeVisible();
    expect(reads).toBeGreaterThanOrEqual(2);
    const atToast = actions;
    const countAtToast = await cartCount(page).innerText();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await garri(page).getByTestId("quick-add-btn").click();
    await page.waitForTimeout(400);
    expect(actions).toBe(atToast);
    await expect(cartCount(page)).toHaveText(countAtToast);
    await page.unroute("**/*");
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
  });

  test("a completed quantity save keeps the newer removal's confirmed fallback", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const cartId = await cartCookie(page);
    const before = await readCartLines("mama-ngozi", cartId);
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldQty = false;
    let removals = 0;
    let reads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!heldQty && isAction(request) && body.includes(row!.id) && quantitiesIn(body).includes(2)) {
        heldQty = true;
        await gate;
        await route.fallback();
        return;
      }
      if (heldQty && isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        removals += 1;
        await route.abort("failed");
        return;
      }
      if (heldQty && isAction(request) && looksLikeRead(body)) {
        reads += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect.poll(() => heldQty).toBe(true);
    const sheet = await openSheet(page);
    await sheet.getByRole("button", { name: "Remove Yellow Garri (Ijebu) from cart" }).click();
    release();
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    await settle(page);
    expect(removals).toBe(1);
    const rowUi = sheet.getByRole("listitem").filter({ hasText: "Yellow Garri" });
    await expect(rowUi.getByTestId("stepper-qty")).toHaveText("2");
    await expect(cartCount(page)).toHaveText("2");
    const saved = await readCartLines("mama-ngozi", cartId);
    expect(saved.find((line) => line.id === row!.id)?.qty).toBe(2);
  });

  test("a repeated failed removal keeps a substitute chosen after the first restore", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const cartId = await openSavedYellowCart(page);
    await expect(page.getByRole("heading", { name: "Yellow Garri (Ijebu)" })).toBeVisible();
    let phase: "first" | "choose" | "second" = "first";
    let firstReads = 0;
    let secondReads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      const removal = isAction(request) && quantitiesIn(body).length === 0 && !looksLikeRead(body);
      if (phase === "first" && removal) {
        await route.abort("failed");
        return;
      }
      if (phase === "first" && isAction(request) && looksLikeRead(body)) {
        firstReads += 1;
        await route.abort("failed");
        return;
      }
      if (phase === "second" && removal) {
        await route.abort("failed");
        return;
      }
      if (phase === "second" && isAction(request) && looksLikeRead(body)) {
        secondReads += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    const sheet = await openSheet(page);
    await sheet.getByRole("button", { name: "Remove Yellow Garri (Ijebu) from cart" }).click();
    await expect.poll(() => firstReads).toBeGreaterThanOrEqual(2);
    await expect(sheet.getByText("Exact item only")).toBeVisible();
    await settle(page);
    phase = "choose";
    await page.getByRole("button", { name: "Close cart" }).click();
    await page.getByRole("button", { name: /Replace with/ }).click();
    await page.getByRole("button").filter({ hasText: "White Garri" }).first().click();
    await expect.poll(async () => {
      const lines = await readCartLines("mama-ngozi", cartId);
      return lines.find((line) => line.listingId === "mn_garri_yellow")?.swapRule ?? "";
    }).toBe("named_substitute");
    const chosen = await openSheet(page);
    await expect(chosen.getByText("Named substitute chosen")).toBeVisible();
    phase = "second";
    await chosen.getByRole("button", { name: "Remove Yellow Garri (Ijebu) from cart" }).click();
    await expect.poll(() => secondReads).toBeGreaterThanOrEqual(2);
    await expect(chosen.getByText("Named substitute chosen")).toBeVisible();
    await expect(chosen.getByText("Exact item only")).toHaveCount(0);
    await settle(page);
    const saved = await readCartLines("mama-ngozi", cartId);
    expect(saved.find((line) => line.listingId === "mn_garri_yellow")).toMatchObject({
      qty: 1,
      swapRule: "named_substitute",
      substituteVariantId: "mn_garri_w_v1",
    });
  });

  test("a returned USER_NOT_FOUND removal restores the line and keeps another line's plus", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellow = before.find((line) => line.listingId === "mn_garri_yellow");
    const white = before.find((line) => line.variantId === "mn_garri_w_v1");
    let reads = 0;
    let yellowWrites = 0;
    await deferRemoval(page);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(yellow!.id)) yellowWrites += 1;
      if (isAction(request) && looksLikeRead(body)) reads += 1;
      await route.fallback();
    });
    const sheet = await openSheet(page);
    await sheet.getByRole("button", { name: "Remove Yellow Garri (Ijebu) from cart" }).click();
    await expect(sheet.getByRole("heading", { name: "Yellow Garri (Ijebu)" })).toHaveCount(0);
    const whiteRow = sheet.getByRole("listitem").filter({ hasText: "White Garri" });
    await whiteRow.getByTestId("stepper-plus").click();
    await expect(whiteRow.getByTestId("stepper-qty")).toHaveText("2");
    const queued = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(queued.find((line) => line.id === white!.id)?.qty).toBe(1);
    await releaseRemoval(page);
    await settle(page);
    expect(yellowWrites).toBe(0);
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(4);
    const rowUi = sheet.getByRole("listitem").filter({ hasText: "Yellow Garri" });
    await expect(rowUi.getByTestId("stepper-qty")).toHaveText("1");
    await expect(whiteRow.getByTestId("stepper-qty")).toHaveText("2");
    const saved = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(saved.find((line) => line.id === yellow!.id)?.qty).toBe(1);
    expect(saved.find((line) => line.id === white!.id)?.qty).toBe(2);
  });

  test("a returned USER_NOT_FOUND removal with failed reads keeps the fallback and another line", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellow = before.find((line) => line.listingId === "mn_garri_yellow");
    const white = before.find((line) => line.variantId === "mn_garri_w_v1");
    let reads = 0;
    let released = false;
    await deferRemoval(page);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (released && isAction(request) && looksLikeRead(body)) {
        reads += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    const sheet = await openSheet(page);
    await sheet.getByRole("button", { name: "Remove Yellow Garri (Ijebu) from cart" }).click();
    await expect(sheet.getByRole("heading", { name: "Yellow Garri (Ijebu)" })).toHaveCount(0);
    const whiteRow = sheet.getByRole("listitem").filter({ hasText: "White Garri" });
    await whiteRow.getByTestId("stepper-plus").click();
    await expect(whiteRow.getByTestId("stepper-qty")).toHaveText("2");
    const queued = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(queued.find((line) => line.id === white!.id)?.qty).toBe(1);
    released = true;
    await releaseRemoval(page);
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    await settle(page);
    await expect(attention(page)).toBeVisible();
    await expect(pending(page)).toBeHidden();
    const rowUi = sheet.getByRole("listitem").filter({ hasText: "Yellow Garri" });
    await expect(rowUi.getByTestId("stepper-qty")).toHaveText("1");
    await expect(whiteRow.getByTestId("stepper-qty")).toHaveText("2");
    const saved = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(saved.find((line) => line.id === yellow!.id)?.qty).toBe(1);
    expect(saved.find((line) => line.id === white!.id)?.qty).toBe(2);
  });

  test("a rejected line keeps another line's first add, decrement, and removal", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await whiteGarri(page).getByTestId("stepper-plus").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellow = before.find((line) => line.listingId === "mn_garri_yellow");
    expect(await deleteCartLine("mama-ngozi", yellow!.id)).toBe(true);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes(yellow!.id)) {
        held = true;
        await gate;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect.poll(() => held).toBe(true);
    await whiteGarri(page).getByTestId("stepper-minus").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    release();
    await settle(page);
    const decremented = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(decremented.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(1);
    expect(decremented.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(0);

    await page.unroute("**/*");
    await addGarri(page);
    await settle(page);
    const again = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellowAgain = again.find((line) => line.listingId === "mn_garri_yellow");
    expect(await deleteCartLine("mama-ngozi", yellowAgain!.id)).toBe(true);
    let releaseDelete: () => void = () => {};
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let heldDelete = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!heldDelete && isAction(request) && body.includes(yellowAgain!.id)) {
        heldDelete = true;
        await deleteGate;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect.poll(() => heldDelete).toBe(true);
    const sheet = await openSheet(page);
    await sheet.getByRole("button", { name: "Remove White Garri from cart" }).click();
    releaseDelete();
    await settle(page);
    await page.getByRole("button", { name: "Close cart" }).click();
    const removed = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(removed.filter((line) => line.variantId === "mn_garri_w_v1")).toHaveLength(0);
    expect(removed.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(0);

    await page.unroute("**/*");
    await addGarri(page);
    await settle(page);
    const third = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellowThird = third.find((line) => line.listingId === "mn_garri_yellow");
    expect(await deleteCartLine("mama-ngozi", yellowThird!.id)).toBe(true);
    let releaseAdd: () => void = () => {};
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    let heldAdd = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!heldAdd && isAction(request) && body.includes(yellowThird!.id)) {
        heldAdd = true;
        await addGate;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect.poll(() => heldAdd).toBe(true);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    releaseAdd();
    await settle(page);
    const added = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(added.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(0);
    expect(added.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(1);
  });

  test("a newer gesture during a recovery read and its retry is kept", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reads = 0;
    let heldRead = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        await route.abort("failed");
        return;
      }
      if (isAction(request) && looksLikeRead(body)) {
        reads += 1;
        if (!heldRead) {
          heldRead = true;
          await readGate;
        }
        await route.fallback();
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => heldRead).toBe(true);
    expect(reads).toBeGreaterThan(0);
    await garri(page).getByTestId("quick-add-btn").click();
    await whiteGarri(page).getByTestId("stepper-plus").click();
    releaseRead();
    await settle(page);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    const duringRead = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(duringRead.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(1);
    expect(duringRead.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(1);
    expect(duringRead.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);

    await page.unroute("**/*");
    await settle(page);
    let releaseRetry: () => void = () => {};
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let retryReads = 0;
    let heldRetry = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        await route.abort("failed");
        return;
      }
      if (isAction(request) && looksLikeRead(body)) {
        retryReads += 1;
        if (retryReads === 1) {
          await route.abort("failed");
          return;
        }
        if (!heldRetry) {
          heldRetry = true;
          await retryGate;
        }
        await route.fallback();
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => heldRetry).toBe(true);
    await garri(page).getByTestId("quick-add-btn").click();
    releaseRetry();
    await settle(page);
    const duringRetry = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(duringRetry.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(1);
    expect(duringRetry.find((line) => line.listingId === "mn_garri_yellow")?.qty).toBe(1);
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
  });

  test("remove then re-add then remove keeps the newest removal", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const cartId = await cartCookie(page);
    const before = await readCartLines("mama-ngozi", cartId);
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let removals = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        removals += 1;
        if (removals === 1) {
          await gate;
          await route.abort("failed");
          return;
        }
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => removals).toBe(1);
    await garri(page).getByTestId("quick-add-btn").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await garri(page).getByTestId("stepper-minus").click();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    release();
    await settle(page);
    expect(removals).toBe(2);
    const saved = await readCartLines("mama-ngozi", cartId);
    expect(saved.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(0);
  });

  test("a held sibling still lets a failed removal restore the confirmed quantity", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await garri(page).getByTestId("stepper-plus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("2");
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellow = before.find((line) => line.listingId === "mn_garri_yellow");
    const white = before.find((line) => line.variantId === "mn_garri_w_v1");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    let reads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!held && isAction(request) && body.includes(white!.id) && quantitiesIn(body).includes(2)) {
        held = true;
        await gate;
        await route.fallback();
        return;
      }
      if (held && isAction(request) && body.includes(yellow!.id) && quantitiesIn(body).length === 0) {
        await route.abort("failed");
        return;
      }
      if (held && isAction(request) && looksLikeRead(body)) {
        reads += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await whiteGarri(page).getByTestId("stepper-plus").click();
    await expect.poll(() => held).toBe(true);
    const sheet = await openSheet(page);
    const rowUi = sheet.getByRole("listitem").filter({ hasText: "Yellow Garri" });
    await rowUi.evaluate((el) => {
      const plus = el.querySelector("[data-testid='stepper-plus']") as HTMLButtonElement | null;
      const trash = el.querySelector("button[aria-label$='from cart']") as HTMLButtonElement | null;
      plus?.click();
      trash?.click();
    });
    release();
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(rowUi.getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    const saved = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(saved.find((line) => line.id === yellow!.id)?.qty).toBe(2);
    expect(saved.find((line) => line.id === white!.id)?.qty).toBe(2);
  });

  test("failed removal reads leave attention on after another line saves", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const yellow = before.find((line) => line.listingId === "mn_garri_yellow");
    let reads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(yellow!.id) && quantitiesIn(body).length === 0) {
        await route.abort("failed");
        return;
      }
      if (isAction(request) && looksLikeRead(body)) {
        reads += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    await whiteGarri(page).getByTestId("stepper-plus").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    await settle(page);
    await expect(attention(page)).toBeVisible();
    await expect(pending(page)).toBeHidden();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    const saved = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(saved.find((line) => line.id === yellow!.id)?.qty).toBe(1);
    expect(saved.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
  });

  test("the first stale recovery read freezes every later removal", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    const before = await readCartLines("mama-ngozi", await cartCookie(page));
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let actions = 0;
    let reads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!isAction(request)) {
        await route.fallback();
        return;
      }
      actions += 1;
      if (body.includes(row!.id) && quantitiesIn(body).length === 0) {
        await route.abort("failed");
        return;
      }
      if (looksLikeRead(body)) {
        reads += 1;
        await route.continue({ headers: { ...request.headers(), "next-action": "d".repeat(42) } });
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "This page is out of date" }).first()).toBeVisible();
    expect(reads).toBe(1);
    const atToast = actions;
    const countAtToast = await cartCount(page).innerText();
    const sheet = await openSheet(page);
    await sheet.getByRole("button", { name: "Remove White Garri from cart" }).click();
    await page.waitForTimeout(400);
    expect(actions).toBe(atToast);
    await expect(cartCount(page)).toHaveText(countAtToast);
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await page.unroute("**/*");
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    const saved = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(saved.find((line) => line.id === row!.id)?.qty).toBe(1);
    expect(saved.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(1);
  });

  test("a lost quantity save keeps the newer removal's confirmed quantity", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const cartId = await cartCookie(page);
    const before = await readCartLines("mama-ngozi", cartId);
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let proved = false;
    let recover = false;
    let reads = 0;
    let removals = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!proved && isAction(request) && body.includes(row!.id) && quantitiesIn(body).includes(2)) {
        await fetchAction(route);
        const committed = await readCartLines("mama-ngozi", cartId);
        expect(committed.find((line) => line.id === row!.id)?.qty).toBe(2);
        proved = true;
        await gate;
        await route.abort("failed");
        return;
      }
      if (recover && isAction(request) && looksLikeRead(body)) {
        reads += 1;
        if (reads === 1) {
          await route.fallback();
          return;
        }
        await route.abort("failed");
        return;
      }
      if (recover && isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        removals += 1;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect.poll(() => proved).toBe(true);
    const sheet = await openSheet(page);
    await sheet.getByRole("button", { name: "Remove Yellow Garri (Ijebu) from cart" }).click();
    recover = true;
    release();
    await expect.poll(() => reads).toBeGreaterThanOrEqual(3);
    await settle(page);
    expect(removals).toBe(1);
    const rowUi = sheet.getByRole("listitem").filter({ hasText: "Yellow Garri" });
    await expect(rowUi.getByTestId("stepper-qty")).toHaveText("2");
    await expect(cartCount(page)).toHaveText("2");
    const saved = await readCartLines("mama-ngozi", cartId);
    expect(saved.find((line) => line.id === row!.id)?.qty).toBe(2);
  });

  test("remove re-add remove keeps the saved substitute when the later removal fails", async ({ page }) => {
    await openGrains(page);
    await addGarri(page);
    const cartId = await cartCookie(page);
    const before = await readCartLines("mama-ngozi", cartId);
    const row = before.find((line) => line.listingId === "mn_garri_yellow");
    expect(
      await writeCartLine("mama-ngozi", row!.id, {
        swapRule: "named_substitute",
        substituteVariantId: "mn_garri_w_v1",
      }),
    ).toBe(true);
    await page.reload();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let removals = 0;
    let reads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(row!.id) && quantitiesIn(body).length === 0) {
        removals += 1;
        if (removals === 1) await gate;
        await route.abort("failed");
        return;
      }
      if (removals > 0 && isAction(request) && looksLikeRead(body)) {
        reads += 1;
        if (reads === 1) {
          await route.fallback();
          return;
        }
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect.poll(() => removals).toBe(1);
    await garri(page).getByTestId("quick-add-btn").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await garri(page).getByTestId("stepper-minus").click();
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    release();
    await expect.poll(() => reads).toBeGreaterThanOrEqual(3);
    await settle(page);
    const sheet = await openSheet(page);
    await expect(sheet.getByText("Named substitute chosen")).toBeVisible();
    await expect(sheet.getByText("Exact item only")).toHaveCount(0);
    const saved = await readCartLines("mama-ngozi", cartId);
    expect(saved.find((line) => line.id === row!.id)).toMatchObject({
      qty: 1,
      swapRule: "named_substitute",
      substituteVariantId: "mn_garri_w_v1",
    });
  });
});

test("cart recovery works with production Vercel flags and no provider keys", async ({ page }) => {
  test.setTimeout(180_000);
  const port = 3299;
  const origin = `http://mama-ngozi.localhost:${port}`;
  const child: ChildProcess = spawn(`pnpm exec next start -p ${port}`, {
    shell: true,
    cwd: process.cwd(),
    stdio: "ignore",
    env: {
      ...process.env,
      VERCEL: "1",
      VERCEL_ENV: "production",
      E2E_STORE_OVERRIDE: "",
      E2E_FAKE_STRIPE: "",
      CI: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_PUBLISHABLE_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      RESEND_API_KEY: "",
      TELNYX_API_KEY: "",
      R2_ACCOUNT_ID: "",
      R2_ACCESS_KEY_ID: "",
      R2_SECRET_ACCESS_KEY: "",
      R2_BUCKET: "",
      R2_PUBLIC_URL: "",
      VERCEL_TOKEN: "",
      GOOGLE_MAPS_API_KEY: "",
      INNGEST_EVENT_KEY: "",
      INNGEST_SIGNING_KEY: "",
    },
  });
  let childExited = false;
  child.on("exit", () => {
    childExited = true;
  });
  function stopServer() {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: true, stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
  try {
    await expect.poll(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        return response.status === 200 || response.status === 503;
      } catch {
        return false;
      }
    }, { timeout: 60_000 }).toBe(true);
    expect(childExited).toBe(false);

    await page.goto(`${origin}/categories/grains-and-flours`);
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    await expect(page.getByRole("heading", { name: "The market could not load" })).toHaveCount(0);
    await garri(page).getByTestId("quick-add-btn").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    await expect.poll(async () => {
      const lines = await readCartLines("mama-ngozi", await cartCookie(page));
      return lines.find((line) => line.listingId === "mn_garri_yellow")?.id ?? "";
    }).not.toBe("");
    const yellow = (await readCartLines("mama-ngozi", await cartCookie(page))).find(
      (line) => line.listingId === "mn_garri_yellow",
    );
    if (!yellow?.id) throw new Error("yellow cart line was not saved before the route");
    let removalAborted = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (isAction(request) && body.includes(yellow!.id) && quantitiesIn(body).length === 0) {
        removalAborted = true;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-minus").click();
    await expect(garri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    expect(removalAborted).toBe(true);
    expect((await readCartLines("mama-ngozi", await cartCookie(page))).find((line) => line.id === yellow!.id)?.qty).toBe(1);
    await page.unroute("**/*");

    await whiteGarri(page).getByTestId("quick-add-btn").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("1");
    await settle(page);
    expect(await deleteCartLine("mama-ngozi", yellow!.id)).toBe(true);
    let releaseWrite: () => void = () => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let heldWrite = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (!heldWrite && isAction(request) && body.includes(yellow!.id)) {
        heldWrite = true;
        await writeGate;
        await route.fallback();
        return;
      }
      await route.fallback();
    });
    await garri(page).getByTestId("stepper-plus").click();
    await expect.poll(() => heldWrite).toBe(true);
    await whiteGarri(page).getByTestId("stepper-plus").click();
    await expect(whiteGarri(page).getByTestId("stepper-qty")).toHaveText("2");
    releaseWrite();
    await settle(page);
    await expect(garri(page).getByTestId("quick-add-btn")).toBeVisible();
    const saved = await readCartLines("mama-ngozi", await cartCookie(page));
    expect(saved.filter((line) => line.listingId === "mn_garri_yellow")).toHaveLength(0);
    expect(saved.find((line) => line.variantId === "mn_garri_w_v1")?.qty).toBe(2);
  } finally {
    stopServer();
  }
});
