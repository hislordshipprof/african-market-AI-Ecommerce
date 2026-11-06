import { expect, test, type Locator, type Page } from "@playwright/test";
import { money } from "../src/lib/format";
import { storeUrl } from "./urls";

const origin = storeUrl("mama-ngozi");
/** Fake-model reply for "html please". The live region must announce this string, not an image. */
const HTML_REPLY = 'See <img onerror="alert(1)"> and [a](http://evil.test).';
const ROUTE_ERROR = "Sorry, something went wrong. Please try again.";

function bubbles(root: Locator) {
  return root.locator('[class*="bubble"]');
}

function liveRegion(root: Locator) {
  return root.locator('[aria-live="polite"]');
}

async function scriptsHave(page: Page, needle: string): Promise<boolean> {
  return page.evaluate(async (wanted) => {
    const srcs = [...document.scripts].map((script) => script.src).filter(Boolean);
    for (const src of srcs) {
      const text = await fetch(src).then((response) => response.text());
      if (text.includes(wanted)) return true;
    }
    return false;
  }, needle);
}

async function send(page: Page, text: string) {
  await page.getByTestId("assistant-composer").fill(text);
  await page.getByTestId("assistant-send").click();
}

test("the launcher stays out of the first load and the chat chunk arrives on open", async ({ page }) => {
  const chat: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat")) chat.push(request.url());
  });
  await page.goto(`${origin}/`);
  await expect(page.getByTestId("assistant-launcher")).toBeVisible();
  expect(chat).toEqual([]);
  expect(await scriptsHave(page, "assistant-chat-chunk-v1")).toBe(false);
  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByRole("dialog", { name: "Shop with help" })).toBeVisible();
  await expect(page.getByTestId("assistant-composer")).toBeFocused();
  await expect.poll(() => scriptsHave(page, "assistant-chat-chunk-v1")).toBe(true);
  expect(await scriptsHave(page, "InvalidPDFException")).toBe(false);
  expect(chat).toEqual([]);
});

test("a shopper can add egusi, undo it, and keep the transcript across pages", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.getByRole("button", { name: "Cook a dish" }).click();
  await expect(page.getByTestId("assistant-composer")).toHaveValue("I want to cook ");
  await send(page, "add two egusi");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await expect(dialog.getByRole("button", { name: "Undo", exact: true })).toBeVisible({ timeout: 20_000 });
  const count = page.getByRole("banner").getByTestId("cart-count");
  await expect(count).toHaveText("2");
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Undone", exact: true })).toBeVisible();
  await expect(count).toHaveText("0", { timeout: 10_000 });
  await page.getByRole("button", { name: "Close Shop with help" }).click();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: /Mama Ngozi/ }).first().click();
  await page.getByRole("link", { name: /Tubers/ }).first().click();
  await page.getByTestId("assistant-launcher").click();
  const again = page.getByRole("dialog", { name: "Shop with help" });
  await expect(bubbles(again).filter({ hasText: "add two egusi" })).toBeVisible();
  await expect(again.getByRole("button", { name: "Undone", exact: true })).toBeVisible();
});

test("markup and stray prices stay plain text, and a card number never leaves the browser", async ({ page }) => {
  let posted = "";
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") {
      posted = request.postData() ?? "";
    }
  });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "html please");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await expect(bubbles(dialog).filter({ hasText: HTML_REPLY })).toBeVisible({ timeout: 20_000 });
  await expect(liveRegion(dialog)).toHaveText(HTML_REPLY, { timeout: 20_000 });
  await expect(dialog.locator("img")).toHaveCount(0);
  await send(page, "stray price");
  await expect(dialog.locator('[class*="bubble"]').filter({ hasText: "I couldn't confirm that price." })).toBeVisible({ timeout: 20_000 });
  await send(page, "4242424242424242");
  await expect(dialog.locator('[class*="bubble"]').filter({ hasText: "Here is what I found." })).toBeVisible({ timeout: 20_000 });
  expect(posted).not.toContain("4242");
});

test("checkout hides the launcher", async ({ page }) => {
  await page.goto(`${origin}/checkout`);
  await expect(page.getByTestId("assistant-launcher")).toHaveCount(0);
});

test("choice chips and the basket summary are keyboard reachable", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const composer = page.getByTestId("assistant-composer");
  await composer.fill("show me choices of egusi");
  await composer.press("Enter");
  const chip = page.getByLabel("Choice chips").getByRole("button").first();
  await expect(chip).toBeVisible({ timeout: 20_000 });
  for (let step = 0; step < 8; step += 1) {
    if (await chip.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Shift+Tab");
  }
  await expect(chip).toBeFocused();
  const label = (await chip.innerText()).trim();
  const choicePosts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") {
      choicePosts.push(request.postData() ?? "");
    }
  });
  await page.keyboard.press("Enter");
  await expect.poll(() => choicePosts.length).toBe(1);
  expect(choicePosts[0]).toContain(label);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Shop with help" })).toBeHidden();
  await expect(page.getByTestId("assistant-launcher")).toBeVisible();
  await page.getByTestId("assistant-launcher").click();
  await page.getByTestId("assistant-composer").fill("show my basket");
  await page.getByTestId("assistant-composer").press("Enter");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await expect(dialog.getByRole("link", { name: "Looks good" })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('[class*="summary"]').getByText(/to reach the .+ minimum order/)).toBeVisible();
  await page.getByRole("button", { name: "Change something" }).click();
  await expect(page.getByRole("dialog", { name: "Shop with help" })).toBeVisible();
  await expect(page.getByTestId("assistant-composer")).toBeFocused();
  await page.getByRole("link", { name: "Looks good" }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole("dialog", { name: "Shop with help" })).toBeHidden();
});

test("Looks good closes the sheet when the summary starts on the cart", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/cart?from=sheet`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "show my basket");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  const link = dialog.getByRole("link", { name: "Looks good" });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/cart$/);
  await expect(dialog).toBeHidden();
  const launcher = page.getByTestId("assistant-launcher");
  await expect(launcher).toBeVisible();
  await launcher.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a fake mid-stream failure recovers when the shopper retries", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "mid-stream");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await expect(dialog.getByRole("status").getByText(ROUTE_ERROR)).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.locator('[class*="bubble"]').filter({ hasText: "Recovered after the interruption." })).toBeVisible({ timeout: 20_000 });
});

test("a stream cut after the tool starts shows an error and retry does not add again", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.route("**/api/assistant/chat", async (route) => {
    if (route.request().headers()["x-e2e-full"] === "1") {
      await route.continue();
      return;
    }
    const request = route.request();
    const full = await page.evaluate(async ({ url, body, headers }) => {
      const response = await fetch(url, { method: "POST", headers, body, credentials: "include" });
      return { status: response.status, type: response.headers.get("content-type"), text: await response.text() };
    }, {
      url: request.url(),
      body: request.postData(),
      headers: { ...request.headers(), "x-e2e-full": "1" },
    });
    await route.fulfill({
      status: full.status,
      contentType: full.type ?? "text/event-stream",
      body: full.text.slice(0, 220),
    });
  });
  await send(page, "add two egusi");
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await expect(dialog.getByRole("status").getByText(ROUTE_ERROR)).toBeVisible({ timeout: 20_000 });
  const count = page.getByRole("banner").getByTestId("cart-count");
  await expect(count).toHaveText("2", { timeout: 10_000 });
  await page.unroute("**/api/assistant/chat");
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByRole("button", { name: "Undo", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(count).toHaveText("2");
});

test("one submit is one request, and a rejected undo says what happened", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.getByTestId("assistant-composer").fill("add two egusi");
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") posts.push(request.url());
  });
  await page.getByTestId("assistant-composer").evaluate((node) => {
    const form = node.closest("form");
    form?.requestSubmit();
    form?.requestSubmit();
  });
  await expect(page.getByRole("dialog", { name: "Shop with help" }).getByRole("button", { name: "Undo", exact: true })).toBeVisible({ timeout: 20_000 });
  expect(posts).toHaveLength(1);
  await page.context().addCookies([{ name: "e2e_undo", value: "reject", url: origin }]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("Could not undo that")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
});

test("product cards show the catalog price", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "show me pictures of egusi");
  await expect(page.locator('[class*="bubble"]').filter({ hasText: "Here is what I found." })).toBeVisible({ timeout: 20_000 });
  const catalog = await page.evaluate(async () => {
    const response = await fetch("/api/storefront/search?q=egusi");
    return response.json() as Promise<{ results: { name: string; price: number }[] }>;
  });
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  expect(catalog.results.length).toBeGreaterThan(0);
  let compared = 0;
  for (const row of catalog.results) {
    const articles = dialog.getByRole("article").filter({ has: page.getByRole("heading", { name: row.name, exact: true }) });
    if (await articles.count() === 0) continue;
    await expect(articles.first()).toContainText(money(row.price));
    compared += 1;
  }
  expect(compared).toBeGreaterThan(0);
});

test("a browser without speech recognition shows no mic", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByRole("button", { name: "Start listening" })).toHaveCount(0);
});

test("spoken words join typed text and nothing sends until Send", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        this.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: false, 0: { transcript: "rice" } }],
        });
        this.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: "rice" } }],
        });
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    const host = window as unknown as {
      SpeechRecognition: typeof FakeRecognition;
      webkitSpeechRecognition: typeof FakeRecognition;
    };
    host.SpeechRecognition = FakeRecognition;
    host.webkitSpeechRecognition = FakeRecognition;
  });
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") {
      posts.push(request.postData() ?? "");
    }
  });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.getByRole("button", { name: "Cook a dish" }).click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await expect(page.getByTestId("assistant-composer")).toHaveValue("I want to cook rice");
  expect(posts).toEqual([]);
  await page.getByTestId("assistant-send").click();
  expect(posts).toEqual([]);
  await expect(page.getByTestId("assistant-composer")).toHaveValue("I want to cook rice");
  await page.getByTestId("assistant-send").click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toContain("I want to cook rice");
  expect(posts[0]?.match(/rice/g)).toHaveLength(1);
  expect(posts[0]).not.toContain("audio");
  expect(posts[0]).not.toMatch(/data:audio|webm|octet-stream/);
});

test("a photo does not change the basket until the customer taps", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.locator('input[accept="image/jpeg,image/png,image/webp"]').setInputFiles("src/lib/assistant/fixtures/list-exif.jpg");
  await expect(page.getByRole("button", { name: /Remove / })).toBeVisible();
  await page.getByTestId("assistant-composer").fill("rice from the photo");
  await page.getByTestId("assistant-send").click();
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await expect(dialog.locator('[class*="bubble"]').filter({ hasText: "I found some of the list" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("banner").getByTestId("cart-count")).toHaveText("0");
  let pdfPost = "";
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") pdfPost = request.postData() ?? "";
  });
  await page.locator('input[accept="application/pdf"]').setInputFiles("src/lib/assistant/fixtures/two-page.pdf");
  await expect(page.getByRole("button", { name: "Remove two-page.pdf" })).toBeVisible();
  await page.getByTestId("assistant-composer").fill("the recipe");
  await page.getByTestId("assistant-send").click();
  await expect.poll(() => pdfPost.includes("data:application/pdf;base64,JVBER")).toBe(true);
  expect(pdfPost).not.toContain("data:application/pdf;base64,\"");
});

test("a rejected file send keeps the draft and a late file does not return", async ({ page }) => {
  await page.route("**/api/assistant/chat", (route) => route.fulfill({ status: 413, body: "too big", contentType: "text/plain" }));
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const dialog = page.getByRole("dialog", { name: "Shop with help" });
  await page.locator('input[accept="image/jpeg,image/png,image/webp"]').setInputFiles("src/lib/assistant/fixtures/list-exif.jpg");
  await expect(page.getByRole("button", { name: /Remove / })).toBeVisible();
  await page.getByTestId("assistant-composer").fill("keep this list");
  await page.getByTestId("assistant-send").click();
  await expect(dialog.getByText("Those files are too big to send. Keep them under 3 MB.")).toBeVisible();
  await expect(page.getByTestId("assistant-composer")).toHaveValue("keep this list");
  await expect(page.getByRole("button", { name: /Remove / })).toBeVisible();
});

test("a file that finishes after the sheet closes does not come back", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.createImageBitmap.bind(window);
    let release: (() => void) | null = null;
    (window as unknown as { __releaseBitmap?: () => void }).__releaseBitmap = () => release?.();
    window.createImageBitmap = ((blob: Blob) => new Promise((resolve, reject) => {
      release = () => { original(blob).then(resolve, reject); };
    })) as typeof createImageBitmap;
  });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.locator('input[accept="image/jpeg,image/png,image/webp"]').setInputFiles("src/lib/assistant/fixtures/list-exif.jpg");
  await page.getByRole("button", { name: "Close Shop with help" }).click();
  await page.evaluate(() => { (window as unknown as { __releaseBitmap?: () => void }).__releaseBitmap?.(); });
  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByRole("button", { name: /Remove / })).toHaveCount(0);
});
