import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import sharp from "sharp";
import { money } from "../src/lib/format";
import { storeUrl } from "./urls";

const origin = storeUrl("mama-ngozi");
/**
 * The fake model answers "html please" with 'See <img onerror="alert(1)"> and [a](http://evil.test).'
 * It renders, and is announced, as text: the HTML stays literal and the plain-http link keeps only its words.
 */
const HTML_REPLY_SHOWN = 'See <img onerror="alert(1)"> and a.';
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
  await expect(page.getByRole("dialog", { name: "Shop with AI" })).toBeVisible();
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
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(dialog.getByRole("button", { name: "Undo", exact: true })).toBeVisible({ timeout: 20_000 });
  const count = page.getByRole("banner").getByTestId("cart-count");
  await expect(count).toHaveText("2");
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Undone", exact: true })).toBeVisible();
  await expect(count).toHaveText("0", { timeout: 10_000 });
  await page.getByRole("button", { name: "Close Shop with AI" }).click();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: /Mama Ngozi/ }).first().click();
  await page.getByRole("link", { name: /Tubers/ }).first().click();
  await page.getByTestId("assistant-launcher").click();
  const again = page.getByRole("dialog", { name: "Shop with AI" });
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
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(bubbles(dialog).filter({ hasText: HTML_REPLY_SHOWN })).toBeVisible({ timeout: 20_000 });
  await expect(liveRegion(dialog)).toHaveText(HTML_REPLY_SHOWN, { timeout: 20_000 });
  await expect(dialog.locator("img")).toHaveCount(0);
  await expect(dialog.locator('a[href*="evil.test"]')).toHaveCount(0);
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
  // Start from a fixed point: the reply has finished and focus is back in the composer.
  const sheet = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(sheet.locator('[class*="bubble"]').filter({ hasText: "Pick one." })).toBeVisible({ timeout: 20_000 });
  await expect(sheet.locator('[class*="typing"]')).toHaveCount(0);
  await composer.focus();
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
  await expect(page.getByRole("dialog", { name: "Shop with AI" })).toBeHidden();
  await expect(page.getByTestId("assistant-launcher")).toBeVisible();
  await page.getByTestId("assistant-launcher").click();
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(dialog.locator('[class*="addedRow"]')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('[class*="typing"]')).toHaveCount(0);
  await page.getByTestId("assistant-composer").fill("show my basket");
  await page.getByTestId("assistant-composer").press("Enter");
  await expect(dialog.getByRole("link", { name: "Looks good" })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('[class*="summary"]').getByText(/more to reach the .+ minimum/)).toBeVisible();
  await page.getByRole("button", { name: "Change something" }).click();
  await expect(page.getByRole("dialog", { name: "Shop with AI" })).toBeVisible();
  await expect(page.getByTestId("assistant-composer")).toBeFocused();
  await page.getByRole("link", { name: "Looks good" }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole("dialog", { name: "Shop with AI" })).toBeHidden();
});

test("Looks good closes the sheet when the summary starts on the cart", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/cart?from=sheet`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "show my basket");
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
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

test("a failed turn can be retried after the customer leaves the sheet", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") posts.push(request.postData() ?? "");
  });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "mid-stream");
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(dialog.getByRole("status").getByText(ROUTE_ERROR)).toBeVisible({ timeout: 20_000 });
  expect(posts).toHaveLength(1);
  const failedId = JSON.parse(posts[0] ?? "{}").message.id as string;
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByTestId("assistant-launcher").click();
  const again = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(again.getByRole("status").getByText(ROUTE_ERROR)).toBeVisible();
  await again.getByRole("button", { name: "Retry" }).click();
  await expect(again.locator('[class*="bubble"]').filter({ hasText: "Recovered after the interruption." })).toBeVisible({ timeout: 20_000 });
  await expect(bubbles(again).filter({ hasText: "mid-stream" })).toHaveCount(1);
  await expect(again.getByRole("button", { name: "Retry" })).toHaveCount(0);
  expect(posts).toHaveLength(2);
  expect(JSON.parse(posts[1] ?? "{}").message.id).toBe(failedId);
});

test("a stream cut after the tool starts shows an error and retry does not add again", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST" && request.headers()["x-e2e-full"] !== "1") {
      posts.push(request.postData() ?? "");
    }
  });
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
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(dialog.getByRole("status").getByText(ROUTE_ERROR)).toBeVisible({ timeout: 20_000 });
  const count = page.getByRole("banner").getByTestId("cart-count");
  await expect(count).toHaveText("2", { timeout: 10_000 });
  const failedId = JSON.parse(posts[0] ?? "{}").message.id as string;
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.unroute("**/api/assistant/chat");
  await page.getByTestId("assistant-launcher").click();
  const again = page.getByRole("dialog", { name: "Shop with AI" });
  await again.getByRole("button", { name: "Retry" }).click();
  await expect(again.getByRole("button", { name: "Undo", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(count).toHaveText("2");
  expect(posts).toHaveLength(2);
  expect(JSON.parse(posts[1] ?? "{}").message.id).toBe(failedId);
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
  await expect(page.getByRole("dialog", { name: "Shop with AI" }).getByRole("button", { name: "Undo", exact: true })).toBeVisible({ timeout: 20_000 });
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
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
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
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(dialog.locator('[class*="bubble"]').filter({ hasText: "I found some of the list" })).toBeVisible({ timeout: 20_000 });
  const sentPhoto = dialog.locator('[class*="user"] img');
  await expect(sentPhoto).toBeVisible();
  await expect(sentPhoto).toHaveAttribute("src", /^data:image\//);
  const followUps: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") followUps.push(request.postData() ?? "");
  });
  await page.getByTestId("assistant-composer").fill("just rice");
  await page.getByTestId("assistant-send").click();
  await expect.poll(() => followUps.length).toBe(1);
  expect(followUps[0]).not.toContain("data:");
  await expect(sentPhoto).toBeVisible();
  await expect(page.getByRole("banner").getByTestId("cart-count")).toHaveText("0");
  await expect(dialog.locator('[class*="bubble"]').filter({ hasText: "Here is what I found." })).toBeVisible({ timeout: 20_000 });
  const chip = dialog.getByLabel("Choice chips").getByRole("button").first();
  await expect(chip).toBeEnabled();
  const picked = (await chip.innerText()).trim();
  await chip.click();
  await expect(page.getByRole("banner").getByTestId("cart-count")).toHaveText("1", { timeout: 20_000 });
  const addedName = (await dialog.locator('[class*="addedRow"]').getByRole("heading").first().innerText()).trim();
  expect(picked.startsWith(`${addedName} (`)).toBe(true);
  const fileReplies = dialog.locator('[class*="bubble"]').filter({ hasText: "I found some of the list" });
  await expect(fileReplies).toHaveCount(1);
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
  // The PDF was read by the production build: the scripted file reply arrives as a new bubble.
  await expect(fileReplies).toHaveCount(2, { timeout: 20_000 });
});

test("a final after a rejected send keeps the restored draft", async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.addInitScript(() => {
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        (window as unknown as { __emitSpeech?: () => void }).__emitSpeech = () => {
          this.onresult?.({
            resultIndex: 0,
            results: [{ isFinal: true, 0: { transcript: "and beans" } }],
          });
        };
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
  await page.route("**/api/assistant/chat", async (route) => {
    await held;
    await route.fulfill({ status: 413, body: "too big", contentType: "text/plain" });
  });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.getByTestId("assistant-composer").fill("rice");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-composer")).toHaveValue("");
  await page.getByRole("button", { name: "Start listening" }).click();
  release();
  await expect(page.getByTestId("assistant-composer")).toHaveValue("rice");
  await page.evaluate(() => {
    (window as unknown as { __emitSpeech?: () => void }).__emitSpeech?.();
  });
  await expect(page.getByTestId("assistant-composer")).toHaveValue("rice and beans");
});

test("a rejected file send keeps the draft and a late file does not return", async ({ page }) => {
  await page.route("**/api/assistant/chat", (route) => route.fulfill({ status: 413, body: "too big", contentType: "text/plain" }));
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
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
  await page.getByRole("button", { name: "Close Shop with AI" }).click();
  await page.evaluate(() => { (window as unknown as { __releaseBitmap?: () => void }).__releaseBitmap?.(); });
  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByRole("button", { name: /Remove / })).toHaveCount(0);
});

test("retrying a failed send keeps one customer bubble", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") posts.push(request.postData() ?? "");
  });
  await page.route("**/api/assistant/chat", (route) => route.fulfill({ status: 500, body: "no", contentType: "text/plain" }));
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
  const bubbles = dialog.locator('[class*="bubble"][class*="user"]');
  await page.getByTestId("assistant-composer").fill("beans");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(bubbles).toHaveCount(1);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => posts.length).toBe(2);
  await expect(bubbles).toHaveCount(1);
  const textIds = posts.map((body) => JSON.parse(body).message.id as string);
  expect(textIds[0]).toBeTruthy();
  expect(textIds[1]).toBe(textIds[0]);

  posts.length = 0;
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.locator('input[accept="image/jpeg,image/png,image/webp"]').setInputFiles("src/lib/assistant/fixtures/list-exif.jpg");
  await expect(page.getByRole("button", { name: /Remove / })).toBeVisible();
  await page.getByTestId("assistant-composer").fill("rice from photo");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(bubbles).toHaveCount(1);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => posts.length).toBe(2);
  await expect(bubbles).toHaveCount(1);
  const fileBodies = posts.map((body) => JSON.parse(body).message as { id: string; parts: unknown[] });
  expect(fileBodies[1]?.id).toBe(fileBodies[0]?.id);
  expect(JSON.stringify(fileBodies[0]?.parts)).toContain("image/jpeg");
  expect(JSON.stringify(fileBodies[1]?.parts)).toContain("image/jpeg");
});

test("closing during a held file send drops the preview", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { created: 0, revoked: 0 };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = ((value: Blob | MediaSource) => {
      state.created += 1;
      return create(value);
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      state.revoked += 1;
      return revoke(url);
    }) as typeof URL.revokeObjectURL;
    (window as unknown as { __objectUrls: typeof state }).__objectUrls = state;
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/assistant/chat", async (route) => {
    await gate;
    await route.fulfill({ status: 413, body: "too big", contentType: "text/plain" });
  });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
  await page.locator('input[accept="image/jpeg,image/png,image/webp"]').setInputFiles("src/lib/assistant/fixtures/list-exif.jpg");
  await expect(page.getByRole("button", { name: /Remove / })).toBeVisible();
  await page.getByTestId("assistant-composer").fill("old draft");
  const before = await page.evaluate(() => (window as unknown as { __objectUrls: { created: number; revoked: number } }).__objectUrls.created);
  await page.getByTestId("assistant-send").click();
  await page.getByRole("button", { name: "Close Shop with AI" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __objectUrls: { revoked: number } }).__objectUrls.revoked)).toBeGreaterThan(0);
  release();
  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByTestId("assistant-composer")).toHaveValue("");
  await expect(page.getByRole("button", { name: /Remove / })).toHaveCount(0);
  const after = await page.evaluate(() => (window as unknown as { __objectUrls: { created: number; revoked: number } }).__objectUrls);
  expect(after.created).toBe(before);
  expect(after.created).toBe(after.revoked);
});

test("a transparent photo stays dark ink on white and keeps the scrubbed name", async ({ page }) => {
  const size = 64;
  const raw = Buffer.alloc(size * size * 4, 0);
  for (let y = 24; y < 40; y += 1) {
    for (let x = 24; x < 40; x += 1) {
      const index = (y * size + x) * 4;
      raw[index + 3] = 255;
    }
  }
  const png = await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") {
      posts.push(request.postData() ?? "");
    }
  });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.locator('input[accept="image/jpeg,image/png,image/webp"]').setInputFiles({
    name: "4242\u200e4242\u200b42424242\u202e.png",
    mimeType: "image/png",
    buffer: png,
  });
  const ready = page.locator('[data-status="ready"]');
  await expect(ready).toBeVisible();
  await expect.soft(ready.getByRole("button", { name: "Remove [card number removed].png" })).toBeVisible();
  await page.getByTestId("assistant-composer").fill("the list");
  await page.getByTestId("assistant-send").click();
  await expect.poll(() => posts.length).toBe(1);
  const body = posts[0] ?? "";
  expect(body).toContain('"filename":"[card number removed].jpg"');
  const withoutBytes = body.replace(/data:[^"]*/g, "");
  for (const leak of ["4242", "‎", "​", "‮"]) expect(withoutBytes).not.toContain(leak);
  const encoded = body.match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/)?.[1];
  expect(encoded).toBeTruthy();
  const { data, info } = await sharp(Buffer.from(encoded ?? "", "base64")).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const index = (y * info.width + x) * info.channels;
    return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0];
  };
  const corner = at(1, 1);
  const ink = at(Math.floor(info.width / 2), Math.floor(info.height / 2));
  expect(Math.min(...corner)).toBeGreaterThan(200);
  expect(Math.max(...ink)).toBeLessThan(80);
});

test("a text turn failing after navigation retains its original Retry", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") posts.push(request.postData() ?? "");
  });
  let release = () => {};
  let hold = true;
  await page.route("**/api/assistant/chat", async (route) => {
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    await route.continue();
  });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "mid-stream");
  await expect.poll(() => posts.length).toBe(1);
  await page.keyboard.press("Escape");
  let releaseCart = () => {};
  const cartGate = new Promise<void>((resolve) => { releaseCart = resolve; });
  let heldCart = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!heldCart && request.method() === "POST" && request.headers()["next-action"]) {
      heldCart = true;
      await cartGate;
    }
    try {
      await route.continue();
    } catch {
      /* navigation closed the request */
    }
  });
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await expect.poll(() => heldCart).toBe(true);
  release();
  hold = false;
  await page.getByTestId("assistant-launcher").click();
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
  const retry = dialog.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible({ timeout: 20_000 });
  await expect(retry).toBeDisabled();
  releaseCart();
  await page.unroute("**/*");
  await expect(retry).toBeEnabled();
  const failedId = JSON.parse(posts[0] ?? "{}").message.id as string;
  hold = true;
  await retry.evaluate((node) => {
    const button = node as HTMLButtonElement;
    button.click();
    button.click();
  });
  await expect.poll(() => posts.length).toBe(2);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Search", exact: true }).click();
  release();
  hold = false;
  await page.getByTestId("assistant-launcher").click();
  const returned = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(returned.locator('[class*="bubble"]').filter({ hasText: "Recovered after the interruption." })).toBeVisible({ timeout: 20_000 });
  await expect(bubbles(returned).filter({ hasText: "mid-stream" })).toHaveCount(1);
  await expect(returned.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(returned.locator("[data-retry]")).toHaveAttribute("data-retry", "");
  expect(posts).toHaveLength(2);
  expect(JSON.parse(posts[1] ?? "{}").message.id).toBe(failedId);
});

async function holdChat(page: Page, settle: (route: Route) => Promise<void>) {
  let release = () => {};
  let finish = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  await page.route("**/api/assistant/chat", async (route) => {
    await gate;
    try {
      await settle(route);
    } finally {
      finish();
    }
  });
  return async function letGo() {
    release();
    await finished;
    await page.unroute("**/api/assistant/chat");
  };
}

test("closing a failed file turn removes Retry without turning it into a text turn", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/assistant/chat") && request.method() === "POST") posts.push(request.postData() ?? "");
  });
  let letGo = await holdChat(page, (route) => route.continue());
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.locator('input[accept="image/jpeg,image/png,image/webp"]').setInputFiles("src/lib/assistant/fixtures/list-exif.jpg");
  await expect(page.getByRole("button", { name: /Remove / })).toBeVisible();
  await page.getByTestId("assistant-composer").fill("file overload rice");
  await page.getByTestId("assistant-send").click();
  await expect.poll(() => posts.length).toBe(1);
  await page.keyboard.press("Escape");
  await letGo();
  await page.getByTestId("assistant-launcher").click();
  const dialog = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(dialog.getByRole("status")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Remove / })).toHaveCount(0);
  const failedId = JSON.parse(posts[0] ?? "{}").message.id as string;
  await send(page, "rice please");
  await expect.poll(() => posts.length).toBe(2);
  const next = JSON.parse(posts[1] ?? "{}").message as { id: string; parts: unknown[] };
  expect(next.id).not.toBe(failedId);
  expect(JSON.stringify(next.parts)).not.toContain("image/jpeg");

  await page.goto(`${origin}/`);
  const beforePdf = posts.length;
  letGo = await holdChat(page, (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "no" }));
  await page.getByTestId("assistant-launcher").click();
  await page.locator('input[accept="application/pdf"]').setInputFiles("src/lib/assistant/fixtures/two-page.pdf");
  await expect(page.getByRole("button", { name: "Remove two-page.pdf" })).toBeVisible();
  await page.getByTestId("assistant-composer").fill("recipe");
  await page.getByTestId("assistant-send").click();
  await expect.poll(() => posts.length).toBe(beforePdf + 1);
  await page.keyboard.press("Escape");
  await letGo();
  await page.getByTestId("assistant-launcher").click();
  const pdfDialog = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(pdfDialog.getByRole("status")).toBeVisible({ timeout: 20_000 });
  await expect(pdfDialog.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(pdfDialog.getByRole("button", { name: /Remove / })).toHaveCount(0);

  await page.goto(`${origin}/`);
  const beforeFiles = posts.length;
  letGo = await holdChat(page, (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "no" }));
  await page.getByTestId("assistant-launcher").click();
  await page.locator('input[accept="image/jpeg,image/png,image/webp"]').setInputFiles("src/lib/assistant/fixtures/list-exif.jpg");
  await expect(page.getByRole("button", { name: /Remove / })).toBeVisible();
  await page.getByTestId("assistant-send").click();
  await expect.poll(() => posts.length).toBe(beforeFiles + 1);
  await page.keyboard.press("Escape");
  await letGo();
  await page.getByTestId("assistant-launcher").click();
  const filesOnly = page.getByRole("dialog", { name: "Shop with AI" });
  await expect(filesOnly.getByRole("status")).toBeVisible({ timeout: 20_000 });
  await expect(filesOnly.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.locator('input[accept="image/jpeg,image/png,image/webp"]').setInputFiles("src/lib/assistant/fixtures/list-exif.jpg");
  await expect(page.getByRole("button", { name: /Remove / })).toBeVisible();
  await page.getByTestId("assistant-composer").fill("fresh list");
  const before = posts.length;
  await page.getByTestId("assistant-send").click();
  await expect.poll(() => posts.length).toBe(before + 1);
  const fresh = JSON.parse(posts.at(-1) ?? "{}").message as { id: string; parts: Array<{ type?: string }> };
  expect(fresh.id).not.toBe(failedId);
  expect(fresh.parts.some((part) => part.type === "file")).toBe(true);
});

test("file presence cannot enable Retry for terminal or message-rate-limited errors", async ({ page }) => {
  const cases = [
    [503, "assistant_unavailable", "Shop with AI isn't available right now."],
    [404, "assistant_disabled", "Shop with AI isn't available right now."],
    [403, "store_suspended", "This store isn't taking orders right now."],
    [503, "assistant_resting", "Shop with AI is resting right now. You can keep shopping the usual way."],
    [429, "rate_limited", "Too many messages."],
  ] as const;
  for (const [status, code, title] of cases) {
    await page.goto(`${origin}/`);
    await page.getByTestId("assistant-launcher").click();
    await page.locator('input[accept="image/jpeg,image/png,image/webp"]').setInputFiles("src/lib/assistant/fixtures/list-exif.jpg");
    await expect(page.getByRole("button", { name: /Remove / })).toBeVisible();
    await page.route("**/api/assistant/chat", (route) => route.fulfill({
      status,
      contentType: "application/json",
      headers: code === "rate_limited" ? { "retry-after": "60" } : {},
      body: JSON.stringify({ error: { code } }),
    }));
    await page.getByTestId("assistant-composer").fill("rice from the photo");
    await page.getByTestId("assistant-send").click();
    const dialog = page.getByRole("dialog", { name: "Shop with AI" });
    await expect(dialog.getByRole("status").getByText(title)).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await page.unroute("**/api/assistant/chat");
  }
});

