import { expect, test } from "@playwright/test";
import { storeUrl } from "./urls";

test("chat returns assistant_unavailable JSON when no Anthropic key is set", async ({ request }) => {
  test.skip(
    !!process.env.ANTHROPIC_API_KEY,
    "ANTHROPIC_API_KEY is set; this check is the keyless build",
  );
  const origin = storeUrl("mama-ngozi");
  const response = await request.post(`${origin}/api/assistant/chat`, {
    headers: {
      origin,
      "content-type": "application/json",
    },
    data: {
      message: {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    },
  });
  expect(response.status()).toBe(503);
  expect(response.headers()["content-type"]).toContain("application/json");
  const body = await response.json();
  expect(body).toMatchObject({ error: { code: "assistant_unavailable" } });
});
