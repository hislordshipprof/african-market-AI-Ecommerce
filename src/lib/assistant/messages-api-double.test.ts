import { expect, it } from "vitest";
import { createMessagesApiDouble } from "./messages-api-double";

const KEY = "sk-ant-fixture-double";
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";

it("the Messages API double rejects what the API rejects", async () => {
  const accepted: Array<{ model: string; extra?: Record<string, unknown> }> = [
    { model: HAIKU },
    { model: HAIKU, extra: { thinking: { type: "adaptive" } } },
    { model: HAIKU, extra: { thinking: { type: "disabled" }, output_config: { effort: "medium" } } },
    { model: HAIKU, extra: { thinking: { type: "disabled" }, output_config: { effort: "high" } } },
    { model: SONNET },
    { model: SONNET, extra: { thinking: { type: "adaptive" } } },
    { model: SONNET, extra: { thinking: { type: "between_tools" }, output_config: { effort: "medium" } } },
    { model: SONNET, extra: { thinking: { type: "between_tools" }, output_config: { effort: "high" } } },
  ];
  for (const example of accepted) {
    expect(await statusFor(validInit(example.model, KEY, example.extra))).toBe(200);
  }

  const rejected: Array<{ model: string; extra?: Record<string, unknown> }> = [
    { model: HAIKU, extra: { thinking: { type: "enabled", budget_tokens: 1024 } } },
    { model: HAIKU, extra: { thinking: { type: "disabled" }, output_config: { effort: "xhigh" } } },
    { model: HAIKU, extra: { thinking: { type: "disabled" }, output_config: { effort: "max" } } },
    { model: HAIKU, extra: { thinking: { type: "between_tools" } } },
    { model: HAIKU, extra: { temperature: 0.2 } },
    { model: HAIKU, extra: { top_p: 0.5 } },
    { model: HAIKU, extra: { top_k: 10 } },
    { model: SONNET, extra: { thinking: { type: "enabled", budget_tokens: 1024 } } },
    { model: SONNET, extra: { thinking: { type: "disabled" } } },
    { model: SONNET, extra: { thinking: { type: "between_tools" }, output_config: { effort: "xhigh" } } },
    { model: SONNET, extra: { thinking: { type: "between_tools" }, output_config: { effort: "max" } } },
    { model: SONNET, extra: { temperature: 1 } },
    { model: SONNET, extra: { top_p: 1 } },
    { model: SONNET, extra: { top_k: 1 } },
  ];
  for (const example of rejected) {
    expect(await statusFor(validInit(example.model, KEY, example.extra))).toBe(400);
  }

  const missingKey = validInit(HAIKU, KEY);
  delete (missingKey.headers as Record<string, string>)["x-api-key"];
  expect(await statusFor(missingKey)).toBe(401);
  expect(await statusFor(validInit(HAIKU, "sk-ant-fixture-other"))).toBe(401);
  expect(await statusFor(validInit(HAIKU, ""))).toBe(401);
});

it("rejects malformed versioned Messages requests independently of adapter rewrites", async () => {
  const wrongMethod = validInit(HAIKU, KEY);
  wrongMethod.method = "GET";
  const wrongPath = validInit(HAIKU, KEY);
  const missingVersion = validInit(HAIKU, KEY);
  delete (missingVersion.headers as Record<string, string>)["anthropic-version"];
  const futureVersion = validInit(HAIKU, KEY);
  futureVersion.headers["anthropic-version"] = "2026-10-21";
  const plainText = validInit(HAIKU, KEY);
  plainText.headers["content-type"] = "text/plain";

  const cases: Array<{ init: RequestInit & { url?: string }; url?: string }> = [
    { init: wrongMethod },
    { init: wrongPath, url: "https://api.anthropic.com/v1/complete" },
    { init: missingVersion },
    { init: futureVersion },
    { init: plainText },
    { init: validInit("claude-opus-5-5", KEY) },
    { init: jsonInit(HAIKU, KEY, { max_tokens: 16, messages: [{ role: "user", content: "ping" }] }) },
    { init: jsonInit(HAIKU, KEY, { model: HAIKU, messages: [{ role: "user", content: "ping" }] }) },
    { init: jsonInit(HAIKU, KEY, { model: HAIKU, max_tokens: 16 }) },
    { init: jsonInit(HAIKU, KEY, { model: HAIKU, max_tokens: 16, messages: [] }) },
  ];

  for (const example of cases) {
    expect(await statusFor(example.init, example.url)).toBe(400);
  }
  expect(await statusFor(validInit(HAIKU, KEY))).toBe(200);
});

async function statusFor(init: RequestInit, url = "https://api.anthropic.com/v1/messages") {
  const double = createMessagesApiDouble(KEY);
  const response = await double.fetch(url, init);
  return response.status;
}

function validInit(
  model: string,
  key: string,
  extra?: Record<string, unknown>,
): RequestInit & { headers: Record<string, string> } {
  return jsonInit(model, key, {
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
    ...extra,
  });
}

function jsonInit(
  _model: string,
  key: string,
  payload: Record<string, unknown>,
): RequestInit & { headers: Record<string, string> } {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": key,
    },
    body: JSON.stringify(payload),
  };
}
