import { expect, test, type Locator, type Page, type Request, type Route } from "@playwright/test";
import {
  readCartLines,
  readListingStock,
  storeIdentity,
  writeListingStock,
  type ListingStock,
} from "./listing-db";
import { storeUrl } from "./urls";

/**
 * Same-render stepper bursts. E16 and E17 have no time or payment logic on
 * this path. E18 and E19 are environment and code-review checks.
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
  return quantitiesIn(body).length === 0 && !body.includes("named_substitute") && !body.includes("store_suggests") && !body.includes("exact_only");
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

    await test.step("saved add whose read fails is not added twice", async () => {
      let phase: "add" | "read" | "done" = "add";
      await page.route("**/*", async (route) => {
        const request = route.request();
        const body = request.postData() ?? "";
        if (phase === "add" && isAction(request) && quantitiesIn(body).includes(2)) {
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
      await garri(page).getByTestId("stepper-plus").click();
      await expectNoCrash(page);
      await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
      await settle(page);
      await page.unroute("**/*");
      await garri(page).getByTestId("stepper-plus").click();
      await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
      await settle(page);
      await page.reload();
      await expect(garri(page).getByTestId("stepper-qty")).toHaveText("3");
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
});
