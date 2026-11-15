import { describe, expect, it, vi } from "vitest";
import { assistantFakeAllowed, E2E_FAKE_ANTHROPIC_KEY } from "./contract";
import { scriptedAssistantFetch } from "./fake-model";

const ID_SHAPE = /^toolu_[A-Za-z0-9_-]{1,94}$/;

function basketRequest(): RequestInit & { url: string } {
  return {
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": E2E_FAKE_ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "show my basket" }],
    }),
  };
}

function toolUses(sse: string): Array<{ id: string; name: string }> {
  const uses: Array<{ id: string; name: string }> = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data) continue;
    const json = JSON.parse(data) as { type?: string; content_block?: { type?: string; id?: string; name?: string } };
    if (json.type === "content_block_start" && json.content_block?.type === "tool_use" && json.content_block.id && json.content_block.name) {
      uses.push({ id: json.content_block.id, name: json.content_block.name });
    }
  }
  return uses;
}

async function basketTools(fetchImpl: typeof fetch): Promise<Array<{ id: string; name: string }>> {
  const request = basketRequest();
  const response = await fetchImpl(request.url, request);
  expect(response.status).toBe(200);
  return toolUses(await response.text());
}

describe("assistant e2e fake", () => {
  it("the e2e fake is selected only with CI=true and no VERCEL, or outside production", () => {
    const env = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ ...process.env, VERCEL: undefined, ...extra });
    expect(assistantFakeAllowed(env({ E2E_FAKE_ASSISTANT: "1", CI: "true" }))).toBe(true);
    expect(assistantFakeAllowed(env({ E2E_FAKE_ASSISTANT: "1", NODE_ENV: "development", CI: undefined }))).toBe(true);
    expect(assistantFakeAllowed(env({ E2E_FAKE_ASSISTANT: "1", CI: "true", VERCEL: "1" }))).toBe(false);
    expect(assistantFakeAllowed(env({ E2E_FAKE_ASSISTANT: "1", NODE_ENV: "production", CI: undefined }))).toBe(false);
    expect(assistantFakeAllowed(env({ E2E_FAKE_ASSISTANT: undefined, NODE_ENV: "development" }))).toBe(false);
  });

  it("repeated and concurrent requests produce fresh valid tool IDs across a cold instance", async () => {
    const [first, second] = await Promise.all([basketTools(scriptedAssistantFetch), basketTools(scriptedAssistantFetch)]);
    expect(first.map((tool) => tool.name)).toEqual(["get_cart_summary"]);
    expect(second.map((tool) => tool.name)).toEqual(["get_cart_summary"]);
    const again = await basketTools(scriptedAssistantFetch);
    expect(again.map((tool) => tool.name)).toEqual(["get_cart_summary"]);
    const followUp = basketRequest();
    followUp.body = JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 256,
      messages: [
        { role: "user", content: "show my basket" },
        { role: "assistant", content: [{ type: "tool_use", id: again[0]?.id, name: "get_cart_summary", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: again[0]?.id, content: "{\"items\":[]}" }] },
      ],
    });
    const continued = await scriptedAssistantFetch(followUp.url, followUp);
    expect(continued.status).toBe(200);
    expect(await continued.text()).toContain("Here is your basket.");
    const ids = [...first, ...second, ...again].map((tool) => tool.id);
    expect(ids.every((id) => ID_SHAPE.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    vi.resetModules();
    const cold = await import("./fake-model");
    const restarted = await basketTools(cold.scriptedAssistantFetch);
    expect(restarted.map((tool) => tool.name)).toEqual(["get_cart_summary"]);
    const restartedId = restarted[0]?.id ?? "";
    expect(ID_SHAPE.test(restartedId)).toBe(true);
    expect(ids).not.toContain(restartedId);
  });
});
