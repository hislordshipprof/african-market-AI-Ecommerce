import { describe, expect, it } from "vitest";
import { E2E_FAKE_ANTHROPIC_KEY, assistantFakeAllowed } from "./contract";
import { scriptStep, scriptedAssistantFetch, wideLayoutText } from "./fake-model";
import { judgeMessagesRequest } from "./messages-api-double";

const base = {
  url: "https://api.anthropic.com/v1/messages",
  method: "POST",
  headers: {
    "x-api-key": E2E_FAKE_ANTHROPIC_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
};

function user(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
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

  it("the scripted responder rejects what Anthropic rejects, including any key but the fake literal", async () => {
    const realKey = await scriptedAssistantFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { ...base.headers, "x-api-key": "sk-ant-real" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 16, messages: [user("egusi")] }),
    });
    expect(realKey.status).toBe(401);
    const hot = judgeMessagesRequest({
      ...base,
      body: {
        model: "claude-haiku-5-5",
        max_tokens: 16,
        temperature: 0.5,
        messages: [user("egusi")],
      },
      expectedKey: E2E_FAKE_ANTHROPIC_KEY,
    });
    expect(hot?.status).toBe(400);
  });

  it("the scripted responder is stateless across interleaved requests", () => {
    const egusi = [user("egusi please")];
    const summary = [user("show my basket")];
    expect(scriptStep(egusi)).toMatchObject({ kind: "tool", name: "search_catalog" });
    expect(scriptStep(summary)).toMatchObject({ kind: "tool", name: "get_cart_summary" });
    expect(scriptStep(egusi)).toMatchObject({ kind: "tool", name: "search_catalog" });
  });

  it("ends a wide-layout picture turn with the url, token, and store name", () => {
    const shown = [
      user("wide layout show me pictures of egusi"),
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_show", name: "show_products", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_show", content: "{}" }] },
    ];
    expect(scriptStep(shown)).toMatchObject({ kind: "text", text: wideLayoutText() });
    const plain = [
      user("show me pictures of egusi"),
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_show", name: "show_products", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_show", content: "{}" }] },
    ];
    expect(scriptStep(plain)).toMatchObject({ kind: "text", text: "Here is what I found." });
  });

  it("retries a scripted mid-stream failure once the failed attempt is in the history", () => {
    expect(scriptStep([user("mid-stream")])).toMatchObject({ kind: "error" });
    expect(scriptStep([
      user("mid-stream"),
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ])).toMatchObject({ kind: "text", text: "Recovered after the interruption." });
    expect(scriptStep([
      { role: "assistant", content: [{ type: "text", text: "earlier" }] },
      user("mid-stream"),
    ])).toMatchObject({ kind: "error" });
  });

  it("script follows only current-turn results and emits unique valid tool-call histories", async () => {
    const first = await scriptedAssistantFetch(base.url, {
      method: "POST",
      headers: base.headers,
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 32, messages: [user("egusi")] }),
    });
    const raw = await first.text();
    expect(raw).toContain("input_json_delta");
    expect(raw.split("content_block_delta").length).toBeGreaterThan(2);
    const withResult = [
      user("egusi"),
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_search_catalog_1_0", name: "search_catalog", input: {} }] },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_search_catalog_1_0",
          content: JSON.stringify({ items: [{ listingId: "l1", variantId: "v1" }, { listingId: "l2", variantId: "v2" }] }),
        }],
      },
    ];
    expect(scriptStep(withResult)).toMatchObject({ kind: "tool", name: "add_to_cart" });
    expect(scriptStep([...withResult, user("egusi again")])).toMatchObject({ kind: "tool", name: "search_catalog" });
    const orphan = judgeMessagesRequest({
      ...base,
      body: {
        model: "claude-haiku-5-5",
        max_tokens: 8,
        messages: [{
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "missing", content: "x" }],
        }],
      },
      expectedKey: E2E_FAKE_ANTHROPIC_KEY,
    });
    expect(orphan?.message).toMatch(/orphaned|tool_result/);
  });
});
