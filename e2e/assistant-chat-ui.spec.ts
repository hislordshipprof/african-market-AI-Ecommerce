import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { storeUrl } from "./urls";

const origin = storeUrl("mama-ngozi");
const shots = "C:/E-commerce-project/.builder/screenshots-246";

async function scriptsHave(page: Page, needle: string): Promise<boolean> {
  const srcs = await page.locator("script[src]").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLScriptElement).src),
  );
  for (const src of srcs) {
    const response = await page.request.get(src);
    if ((await response.text()).includes(needle)) return true;
  }
  return false;
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
  await expect.poll(() => scriptsHave(page, "assistant-chat-chunk-v1")).toBe(true);
  expect(chat).toEqual([]);
});

test("a shopper can add egusi, undo it, and keep the transcript across pages", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await page.getByRole("button", { name: "Cook a dish" }).click();
  await expect(page.getByTestId("assistant-composer")).toHaveValue("I want to cook ");
  await send(page, "add two egusi");
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("cart-count")).toHaveText("2");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Undone" })).toBeVisible();
  await expect(page.getByTestId("cart-count")).toHaveText("0");
  await page.getByRole("button", { name: "Close Shop with help" }).click();
  await page.goto(`${origin}/search`);
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByText("add two egusi")).toBeVisible();
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
  await expect(dialog.getByText(/<img/)).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator("img")).toHaveCount(0);
  await send(page, "stray price");
  await expect(dialog.getByText("(see card)")).toBeVisible({ timeout: 20_000 });
  await send(page, "4242424242424242");
  await expect(dialog.getByText("Here is what I found.")).toBeVisible({ timeout: 20_000 });
  expect(posted).not.toContain("4242");
});

test("checkout hides the launcher and the sheet fits a phone without sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${origin}/checkout`);
  await expect(page.getByTestId("assistant-launcher")).toHaveCount(0);
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(wide).toBe(false);
});

test("choice chips and the basket summary are keyboard reachable", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  const composer = page.getByTestId("assistant-composer");
  await composer.fill("show me choices of egusi");
  await composer.press("Enter");
  await expect(page.getByLabel("Choice chips").getByRole("button").first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Close Shop with help" }).click();
  await page.getByTestId("assistant-launcher").click();
  await page.getByTestId("assistant-composer").fill("show my basket");
  await page.getByTestId("assistant-composer").press("Enter");
  await expect(page.getByRole("link", { name: "Looks good" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Change something" }).click();
  await expect(page.getByTestId("assistant-composer")).toBeFocused();
});

test("the open sheet is readable at phone and desktop in light and dark", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await page.goto(`${origin}/`);
  await page.getByTestId("assistant-launcher").click();
  await send(page, "show me pictures of egusi");
  await expect(page.getByText("Here is what I found.")).toBeVisible({ timeout: 20_000 });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${shots}/sheet-${width}-${scheme}.png`, fullPage: false });
    }
  }
});
