import { APICallError, generateText } from "ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMessagesApiDouble,
  type MessagesApiDouble,
  type RecordedMessagesRequest,
} from "./messages-api-double";
import {
  assistantModelId,
  assistantProviderOptions,
  AssistantConfigError,
  createAssistantModel,
  type AssistantModelId,
} from "./model";

const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const KEY_A = "sk-ant-fixture-a";
const KEY_B = "sk-ant-fixture-b";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

beforeEach(() => {
  stubAssistantEnv({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("defaults to claude-haiku-5-5 when ASSISTANT_MODEL is unset or empty", () => {
  stubAssistantEnv({ configured: undefined });
  expect(assistantModelId()).toBe(HAIKU);
  stubAssistantEnv({ configured: "" });
  expect(assistantModelId()).toBe(HAIKU);
});

it("accepts claude-sonnet-5-5", () => {
  stubAssistantEnv({ configured: SONNET });
  expect(assistantModelId()).toBe(SONNET);
});

it("rejects unknown, padded, differently cased or oversized model ids", () => {
  const rejected = [
    "gpt-4o",
    "claude-opus-5-5",
    "Claude-Haiku-5-5",
    " claude-haiku-5-5",
    "claude-haiku-5-5 ",
    "x".repeat(10_000),
  ];
  for (const model of rejected) {
    stubAssistantEnv({ configured: model });
    expect(() => assistantModelId()).toThrow(AssistantConfigError);
    try {
      assistantModelId();
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantConfigError);
      const message = (error as Error).message;
      expect(message).toBe(
        "ASSISTANT_MODEL must be claude-haiku-5-5 or claude-sonnet-5-5.",
      );
    }
  }
});

it("reads the environment on every call, not at import", () => {
  stubAssistantEnv({ configured: undefined, key: undefined });
  expect(assistantModelId()).toBe(HAIKU);
  stubAssistantEnv({ configured: SONNET, key: KEY_A });
  expect(assistantModelId()).toBe(SONNET);
  const first = createAssistantModel();
  expect(first.modelId).toBe(SONNET);
  stubAssistantEnv({ configured: HAIKU, key: KEY_B });
  expect(assistantModelId()).toBe(HAIKU);
  const second = createAssistantModel();
  expect(second.modelId).toBe(HAIKU);
  expect(first.modelId).toBe(SONNET);
});

it("refuses to build without a usable ANTHROPIC_API_KEY and sends nothing", async () => {
  const injected = createMessagesApiDouble(KEY_A);
  const globalCalls = trapGlobalFetch();
  for (const key of [undefined, "", "   "]) {
    injected.calls.length = 0;
    globalCalls.length = 0;
    stubAssistantEnv({ configured: HAIKU, key });
    expect(() => createAssistantModel({ fetch: injected.fetch })).toThrow(AssistantConfigError);
    try {
      createAssistantModel({ fetch: injected.fetch });
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantConfigError);
      expect((error as Error).message).toContain("ANTHROPIC_API_KEY");
      expect((error as Error).message.includes("   ")).toBe(false);
    }
    expect(injected.calls).toHaveLength(0);
    expect(globalCalls).toHaveLength(0);
  }
});

it("haiku request disables thinking at medium effort with no provider warnings", async () => {
  const { result, call } = await completeWithInjectedFetch(HAIKU, KEY_A);
  expect(call.body?.model).toBe(HAIKU);
  expect(call.body?.thinking).toEqual({ type: "disabled" });
  expect(call.body?.output_config).toEqual({ effort: "medium" });
  expect(result.warnings).toEqual([]);
  expect(result.text).toBe("ok");
  assertDirectAnthropicCall(call, KEY_A);
});

it("sonnet request sends no thinking option and gets no provider warnings", async () => {
  const { result, call } = await completeWithInjectedFetch(SONNET, KEY_A);
  expect(call.body?.model).toBe(SONNET);
  expect(call.body).not.toHaveProperty("thinking");
  expect(call.body?.output_config).toEqual({ effort: "medium" });
  expect(result.warnings).toEqual([]);
  expect(result.text).toBe("ok");
  assertDirectAnthropicCall(call, KEY_A);
});

it("requests carry no sampling parameters, and a caller's temperature is dropped with a warning", async () => {
  stubAssistantEnv({ configured: HAIKU, key: KEY_A, baseURL: undefined });
  const globalCalls = trapGlobalFetch();
  const double = createMessagesApiDouble(KEY_A);
  const model = createAssistantModel({ fetch: double.fetch });
  const result = await generateText({
    model,
    prompt: "ping",
    temperature: 0.2,
    topP: 0.5,
    topK: 10,
    providerOptions: assistantProviderOptions(resolvedId(model)),
  });
  const body = double.calls[0]?.body;
  expect(body).not.toHaveProperty("temperature");
  expect(body).not.toHaveProperty("top_p");
  expect(body).not.toHaveProperty("top_k");
  expect((result.warnings ?? []).length).toBeGreaterThan(0);
  expect(globalCalls).toHaveLength(0);
});

it("sends only to api.anthropic.com with the Anthropic key, ignoring ANTHROPIC_BASE_URL and gateway credentials", async () => {
  stubAssistantEnv({
    configured: HAIKU,
    key: KEY_A,
    baseURL: "https://ai-gateway.vercel.sh",
  });
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "oidc-fixture");
  vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-fixture");
  const globalCalls = trapGlobalFetch();
  const double = createMessagesApiDouble(KEY_A);
  const model = createAssistantModel({ fetch: double.fetch });
  const result = await generateText({
    model,
    prompt: "ping",
    providerOptions: assistantProviderOptions(resolvedId(model)),
  });
  const call = double.calls[0];
  expect(call).toBeDefined();
  assertDirectAnthropicCall(call!, KEY_A);
  expect(model.provider).toBe("anthropic.messages");
  expect(model.modelId).toBe(HAIKU);
  expect(call?.body?.model).toBe(HAIKU);
  expect(result.warnings).toEqual([]);
  expect(globalCalls).toHaveLength(0);
  expect(JSON.stringify(call).includes("oidc-fixture")).toBe(false);
  expect(JSON.stringify(call).includes("gateway-fixture")).toBe(false);
});

it("an empty ANTHROPIC_BASE_URL does not break model creation", async () => {
  stubAssistantEnv({ configured: SONNET, key: KEY_A, baseURL: "" });
  const double = createMessagesApiDouble(KEY_A);
  const model = createAssistantModel({ fetch: double.fetch });
  const result = await generateText({
    model,
    prompt: "ping",
    providerOptions: assistantProviderOptions(resolvedId(model)),
  });
  expect(model.provider).toBe("anthropic.messages");
  expect(double.calls[0]?.url).toBe(MESSAGES_URL);
  expect(result.text).toBe("ok");
});

it("a rejected key is reported once and not retried", async () => {
  stubAssistantEnv({ configured: HAIKU, key: KEY_A, baseURL: undefined });
  const globalCalls = trapGlobalFetch();
  const double = createMessagesApiDouble("sk-ant-fixture-revoked");
  const model = createAssistantModel({ fetch: double.fetch });
  await expect(
    generateText({
      model,
      prompt: "ping",
      providerOptions: assistantProviderOptions(resolvedId(model)),
    }),
  ).rejects.toSatisfy(
    (error: unknown) => APICallError.isInstance(error) && error.statusCode === 401,
  );
  expect(double.calls).toHaveLength(1);
  expect(globalCalls).toHaveLength(0);
});

it("no-argument factory sends the same direct Anthropic request for both models", async () => {
  for (const id of [HAIKU, SONNET] as const) {
    const double = createMessagesApiDouble(KEY_A);
    vi.stubGlobal("fetch", double.fetch);
    stubAssistantEnv({
      configured: id,
      key: KEY_A,
      baseURL: "https://ai-gateway.vercel.sh",
    });
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "oidc-fixture");
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-fixture");
    const model = createAssistantModel();
    const result = await generateText({
      model,
      prompt: "ping",
      providerOptions: assistantProviderOptions(resolvedId(model)),
    });
    expect(double.calls).toHaveLength(1);
    const call = double.calls[0]!;
    assertDirectAnthropicCall(call, KEY_A);
    expect(call.body?.model).toBe(id);
    expect(model.provider).toBe("anthropic.messages");
    expect(model.modelId).toBe(id);
    expect(result.text).toBe("ok");
    expect(result.warnings).toEqual([]);
    if (id === HAIKU) {
      expect(call.body?.thinking).toEqual({ type: "disabled" });
    } else {
      expect(call.body).not.toHaveProperty("thinking");
    }
    expect(call.body?.output_config).toEqual({ effort: "medium" });
  }
});

it("valid model construction performs no fetch", () => {
  stubAssistantEnv({ configured: HAIKU, key: KEY_A, baseURL: "   " });
  const globalCalls = trapGlobalFetch();
  const double = createMessagesApiDouble(KEY_A);
  const model = createAssistantModel({ fetch: double.fetch });
  expect(model.modelId).toBe(HAIKU);
  expect(model.provider).toBe("anthropic.messages");
  expect(double.calls).toHaveLength(0);
  expect(globalCalls).toHaveLength(0);
  const bare = createAssistantModel();
  expect(bare.modelId).toBe(HAIKU);
  expect(double.calls).toHaveLength(0);
  expect(globalCalls).toHaveLength(0);
});

it("created models retain credentials model and transport across interleaved requests", async () => {
  stubAssistantEnv({ configured: HAIKU, key: KEY_A, baseURL: "https://ai-gateway.vercel.sh" });
  const first = gatedDouble(KEY_A);
  const modelA = createAssistantModel({ fetch: first.fetch });
  stubAssistantEnv({ configured: SONNET, key: KEY_B, baseURL: "" });
  const second = gatedDouble(KEY_B);
  const modelB = createAssistantModel({ fetch: second.fetch });

  const pendingA = generateText({
    model: modelA,
    prompt: "ping",
    providerOptions: assistantProviderOptions(resolvedId(modelA)),
  });
  const pendingB = generateText({
    model: modelB,
    prompt: "ping",
    providerOptions: assistantProviderOptions(resolvedId(modelB)),
  });

  await vi.waitFor(() => {
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });

  first.release();
  second.release();
  const [resultA, resultB] = await Promise.all([pendingA, pendingB]);

  expect(first.calls[0]?.body?.model).toBe(HAIKU);
  expect(first.calls[0]?.body?.thinking).toEqual({ type: "disabled" });
  expect(first.calls[0]?.headers["x-api-key"] === KEY_A).toBe(true);
  expect(second.calls[0]?.body?.model).toBe(SONNET);
  expect(second.calls[0]?.body).not.toHaveProperty("thinking");
  expect(second.calls[0]?.headers["x-api-key"] === KEY_B).toBe(true);
  expect(first.calls[0]?.url).toBe(MESSAGES_URL);
  expect(second.calls[0]?.url).toBe(MESSAGES_URL);
  expect(resultA.text).toBe("ok");
  expect(resultB.text).toBe("ok");
  expect(resultA.warnings).toEqual([]);
  expect(resultB.warnings).toEqual([]);
});

it("provider options do not share mutable nested state", () => {
  const haiku = assistantProviderOptions(HAIKU);
  const sonnet = assistantProviderOptions(SONNET);
  const mutableHaiku = haiku.anthropic as { thinking?: { type: string }; effort: string };
  mutableHaiku.thinking = { type: "enabled" };
  mutableHaiku.effort = "max";
  const mutableSonnet = sonnet.anthropic as { effort: string };
  mutableSonnet.effort = "low";

  const nextHaiku = assistantProviderOptions(HAIKU);
  const nextSonnet = assistantProviderOptions(SONNET);
  if (!("thinking" in nextHaiku.anthropic)) {
    throw new Error("haiku options omitted thinking");
  }
  expect(nextHaiku.anthropic.thinking).toEqual({ type: "disabled" });
  expect(nextHaiku.anthropic.effort).toBe("medium");
  expect(nextSonnet.anthropic).not.toHaveProperty("thinking");
  expect(nextSonnet.anthropic.effort).toBe("medium");
});

it("missing Anthropic credentials never fall back to Vercel credentials", () => {
  stubAssistantEnv({ configured: "gpt-4o", key: undefined, baseURL: "https://ai-gateway.vercel.sh" });
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("CI", "1");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "oidc-fixture");
  vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-fixture");
  const globalCalls = trapGlobalFetch();
  const double = createMessagesApiDouble(KEY_A);

  expect(() => createAssistantModel({ fetch: double.fetch })).toThrow(AssistantConfigError);
  try {
    createAssistantModel({ fetch: double.fetch });
  } catch (error) {
    expect(error).toBeInstanceOf(AssistantConfigError);
    const message = (error as Error).message;
    expect(message).toContain("ASSISTANT_MODEL");
    expect(message.includes("gpt-4o")).toBe(false);
    expect(message.includes("oidc-fixture")).toBe(false);
    expect(message.includes("gateway-fixture")).toBe(false);
  }

  stubAssistantEnv({ configured: HAIKU, key: "   ", baseURL: "" });
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "oidc-fixture");
  vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-fixture");
  expect(() => createAssistantModel()).toThrow(AssistantConfigError);
  try {
    createAssistantModel();
  } catch (error) {
    expect((error as Error).message).toContain("ANTHROPIC_API_KEY");
    expect((error as Error).message.includes("oidc-fixture")).toBe(false);
  }
  expect(double.calls).toHaveLength(0);
  expect(globalCalls).toHaveLength(0);
});

function stubAssistantEnv(values: { configured?: string; key?: string; baseURL?: string }) {
  vi.stubEnv("ASSISTANT_MODEL", values.configured);
  vi.stubEnv("ANTHROPIC_API_KEY", values.key);
  vi.stubEnv("ANTHROPIC_BASE_URL", values.baseURL);
}

function trapGlobalFetch(): unknown[] {
  const calls: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    calls.push("global");
    return Promise.reject(new Error("global fetch was called"));
  });
  return calls;
}

function resolvedId(model: { modelId: string }): AssistantModelId {
  if (model.modelId === HAIKU || model.modelId === SONNET) return model.modelId;
  throw new Error("resolved model id is outside the allow-list");
}

function assertDirectAnthropicCall(call: RecordedMessagesRequest, key: string) {
  expect(call.url).toBe(MESSAGES_URL);
  expect(call.method).toBe("POST");
  expect(call.headers["anthropic-version"]).toBe("2023-06-01");
  expect(call.headers["content-type"]?.includes("application/json")).toBe(true);
  expect(call.headers["x-api-key"] === key).toBe(true);
  expect(call.headers.authorization).toBeUndefined();
  expect(call.body).not.toHaveProperty("temperature");
  expect(call.body).not.toHaveProperty("top_p");
  expect(call.body).not.toHaveProperty("top_k");
}

async function completeWithInjectedFetch(modelId: AssistantModelId, key: string) {
  stubAssistantEnv({ configured: modelId, key, baseURL: undefined });
  const globalCalls = trapGlobalFetch();
  const double = createMessagesApiDouble(key);
  const model = createAssistantModel({ fetch: double.fetch });
  const result = await generateText({
    model,
    prompt: "ping",
    providerOptions: assistantProviderOptions(resolvedId(model)),
  });
  expect(double.calls).toHaveLength(1);
  expect(globalCalls).toHaveLength(0);
  const call = double.calls[0];
  if (!call) throw new Error("expected one recorded request");
  return { result, call, double };
}

function gatedDouble(expectedKey: string): MessagesApiDouble & { release: () => void } {
  const inner = createMessagesApiDouble(expectedKey);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = inner.fetch(input, init);
    await gate;
    return response;
  };
  return { fetch, calls: inner.calls, release };
}
