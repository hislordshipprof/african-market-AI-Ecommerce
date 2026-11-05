import { expect, test } from "@playwright/test";
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
