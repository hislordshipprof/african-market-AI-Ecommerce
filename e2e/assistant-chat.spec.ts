import { expect, test } from "@playwright/test";
import { laneSmokePort, reservePort, startSpawnedServer } from "./spawned-server";
import { storeUrl } from "./urls";

test("chat returns assistant_unavailable JSON when no Anthropic key is set", async ({ page }) => {
  test.skip(process.env.E2E_FAKE_ASSISTANT === "1", "the scripted assistant replaces the keyless check");
  test.skip(
    !!process.env.ANTHROPIC_API_KEY,
    "ANTHROPIC_API_KEY is set; this check is the keyless build",
  );
  // Chromium resolves *.localhost. Node's DNS on Windows does not, so the
  // shopper request has to come from the store page, the way a browser does.
  const origin = storeUrl("mama-ngozi");
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      }),
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.json(),
    };
  }, `${origin}/api/assistant/chat`);
  expect(result.status).toBe(503);
  expect(result.contentType).toContain("application/json");
  expect(result.body).toMatchObject({ error: { code: "assistant_unavailable" } });
});

test("production assistant gates fail closed without relying on local env files", async ({ page }) => {
  test.setTimeout(240_000);
  const fakeKey = "e2e-fake-anthropic-key";
  async function boot(env: Record<string, string>) {
    const port = await reservePort(laneSmokePort());
    const running = await startSpawnedServer({
      command: `pnpm exec next start -p ${port}`,
      shell: true,
      cwd: process.cwd(),
      port,
      env: {
        ...process.env,
        CI: "true",
        VERCEL: "",
        VERCEL_ENV: "",
        STRIPE_SECRET_KEY: "",
        STRIPE_PUBLISHABLE_KEY: "",
        STRIPE_WEBHOOK_SECRET: "",
        E2E_STORE_OVERRIDE: "1",
        ...env,
      },
      healthUrl: `http://127.0.0.1:${port}/api/health`,
      healthOk: (status) => status === 200 || status === 503,
    });
    return { port, running, origin: `http://mama-ngozi.localhost:${port}` };
  }

  const blank = await boot({
    ASSISTANT_CHAT_ENABLED: "1",
    E2E_FAKE_ASSISTANT: "",
    ANTHROPIC_API_KEY: "",
  });
  try {
    await page.goto(`${blank.origin}/`);
    await page.getByTestId("assistant-launcher").click();
    await page.getByTestId("assistant-composer").fill("hello");
    await page.getByTestId("assistant-send").click();
    const dialog = page.getByRole("dialog", { name: "Shop with AI" });
    await expect(dialog.getByText("Shop with AI isn't available right now.")).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole("button", { name: "Retry" })).toHaveCount(0);
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { id: "blank-key", role: "user", parts: [{ type: "text", text: "hello" }] } }),
      });
      return { status: response.status, body: await response.json() };
    }, `${blank.origin}/api/assistant/chat`);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: { code: "assistant_unavailable" } });
  } finally {
    await blank.running.stop();
  }

  const disabled = await boot({
    ASSISTANT_CHAT_ENABLED: "",
    E2E_FAKE_ASSISTANT: "",
    ANTHROPIC_API_KEY: "",
  });
  try {
    await page.goto(`${disabled.origin}/`);
    await expect(page.getByTestId("assistant-launcher")).toHaveCount(0);
  } finally {
    await disabled.running.stop();
  }

  const hosted = await boot({
    ASSISTANT_CHAT_ENABLED: "1",
    E2E_FAKE_ASSISTANT: "1",
    ANTHROPIC_API_KEY: fakeKey,
  });
  try {
    await page.goto(`${hosted.origin}/`);
    await page.getByTestId("assistant-launcher").click();
    await page.getByTestId("assistant-composer").fill("mid-stream");
    await page.getByTestId("assistant-send").click();
    const dialog = page.getByRole("dialog", { name: "Shop with AI" });
    await expect(dialog.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole("button", { name: "Retry" }).click();
    await expect(dialog.getByText("Recovered after the interruption.")).toBeVisible({ timeout: 20_000 });
  } finally {
    await hosted.running.stop();
  }
});
