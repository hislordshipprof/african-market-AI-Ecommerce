import { describe, expect, it } from "vitest";
import { judgeMessagesRequest } from "./messages-api-double";

const KEY = "sk-ant-test-key";

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return judgeMessagesRequest({
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": KEY,
      ...headers,
    },
    body: {
      model: "claude-haiku-5-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
      ...body,
    },
    expectedKey: KEY,
  });
}

describe("Messages API double", () => {
  it("rejects malformed versioned Messages requests independently of adapter rewrites", () => {
    expect(request({}, { "x-api-key": "" })?.status).toBe(401);
    expect(request({}, { "x-api-key": "wrong" })?.status).toBe(401);
    expect(
      judgeMessagesRequest({
        url: "https://ai-gateway.vercel.sh/v1/chat",
        method: "GET",
        headers: {
          "content-type": "application/json",
          "x-api-key": KEY,
        },
        body: { model: "claude-haiku-5-5", max_tokens: 1, messages: [] },
        expectedKey: KEY,
      })?.status,
    ).toBe(400);
    expect(request({}, { "anthropic-version": "2026-10-21" })?.status).toBe(400);
    expect(request({ model: "gpt-4o" })?.status).toBe(400);
    expect(request({ messages: undefined, max_tokens: undefined })?.status).toBe(400);
    expect(request({ thinking: { type: "enabled", budget_tokens: 100 } })?.status).toBe(400);
    expect(request({ thinking: { type: "between_tools" } })?.status).toBe(400);
    expect(
      request({
        thinking: { type: "disabled" },
        output_config: { effort: "max" },
      })?.status,
    ).toBe(400);
    expect(
      request({
        model: "claude-sonnet-5-5",
        thinking: { type: "disabled" },
      })?.status,
    ).toBe(400);
    expect(
      request({
        model: "claude-sonnet-5-5",
        thinking: { type: "enabled", budget_tokens: 100 },
      })?.status,
    ).toBe(400);
    expect(
      request({
        model: "claude-sonnet-5-5",
        thinking: { type: "between_tools" },
        output_config: { effort: "xhigh" },
      })?.status,
    ).toBe(400);
    expect(request({ temperature: 0.2 })?.status).toBe(400);
    expect(request({ top_p: 0.9 })?.status).toBe(400);
    expect(request({ top_k: 10 })?.status).toBe(400);
    expect(request({ tools: [{ name: "bad name" }] })?.status).toBe(400);
    expect(
      request({
        system: [
          { type: "text", text: "a", cache_control: { type: "ephemeral" } },
          { type: "text", text: "b", cache_control: { type: "ephemeral" } },
          { type: "text", text: "c", cache_control: { type: "ephemeral" } },
          { type: "text", text: "d", cache_control: { type: "ephemeral" } },
          { type: "text", text: "e", cache_control: { type: "ephemeral" } },
        ],
      })?.status,
    ).toBe(400);
    expect(
      request({
        system: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "9m" } }],
      })?.status,
    ).toBe(400);
    expect(request({ thinking: { type: "disabled" }, output_config: { effort: "medium" } })).toBeNull();
    expect(
      request({
        model: "claude-sonnet-5-5",
        output_config: { effort: "medium" },
      }),
    ).toBeNull();
  });
});
