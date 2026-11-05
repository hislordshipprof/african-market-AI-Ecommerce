import { generateText, APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssistantConfigError,
  assistantModelId,
  assistantProviderOptions,
  createAssistantModel,
} from "./model";
import { createMessagesApiDouble } from "./messages-api-double";

const KEY_A = "sk-ant-test-key-a";
const KEY_B = "sk-ant-test-key-b";

function modelFields(model: unknown): { modelId: string; provider: string } {
  return model as { modelId: string; provider: string };
}

function stubAssistant(env: {
  model?: string;
  key?: string;
  baseUrl?: string;
  gateway?: string;
  oidc?: string;
  vercel?: string;
}) {
  vi.stubEnv("ASSISTANT_MODEL", env.model);
  vi.stubEnv("ANTHROPIC_API_KEY", env.key);
  vi.stubEnv("ANTHROPIC_BASE_URL", env.baseUrl);
  vi.stubEnv("AI_GATEWAY_API_KEY", env.gateway);
  vi.stubEnv("VERCEL_OIDC_TOKEN", env.oidc);
  vi.stubEnv("VERCEL", env.vercel);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("assistant model config", () => {
  it("defaults to claude-haiku-5-5 when ASSISTANT_MODEL is unset or empty", () => {
    stubAssistant({});
    expect(assistantModelId()).toBe("claude-haiku-5-5");
    stubAssistant({ model: "" });
    expect(assistantModelId()).toBe("claude-haiku-5-5");
  });

  it("accepts claude-sonnet-5-5", () => {
    stubAssistant({ model: "claude-sonnet-5-5" });
    expect(assistantModelId()).toBe("claude-sonnet-5-5");
  });

  it("rejects unknown, padded, differently cased or oversized model ids", () => {
    for (const model of [
      "gpt-4o",
      "claude-opus-5-5",
      "Claude-Haiku-5-5",
      " claude-haiku-5-5",
      "claude-haiku-5-5 ",
      "x".repeat(10_000),
    ]) {
      stubAssistant({ model });
      expect(() => assistantModelId(), model.slice(0, 40)).toThrow(AssistantConfigError);
    }
  });

  it("reads the environment on every call, not at import", async () => {
    stubAssistant({});
    expect(assistantModelId()).toBe("claude-haiku-5-5");
    stubAssistant({ model: "claude-sonnet-5-5", key: KEY_A });
    expect(assistantModelId()).toBe("claude-sonnet-5-5");
    const first = createAssistantModel();
    stubAssistant({ model: "claude-haiku-5-5", key: KEY_B });
    const second = createAssistantModel();
    expect(modelFields(first).modelId).toBe("claude-sonnet-5-5");
    expect(modelFields(second).modelId).toBe("claude-haiku-5-5");
  });

  it("refuses to build without a usable ANTHROPIC_API_KEY and sends nothing", async () => {
    const injected = vi.fn<typeof fetch>();
    const globalFetch = vi.spyOn(globalThis, "fetch");
    for (const key of [undefined, "", "   "]) {
      stubAssistant({ key });
      expect(() => createAssistantModel({ fetch: injected })).toThrow(AssistantConfigError);
    }
    expect(injected).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("valid model construction performs no fetch", () => {
    stubAssistant({ key: KEY_A });
    const injected = vi.fn<typeof fetch>();
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const model = createAssistantModel({ fetch: injected });
    expect(modelFields(model).modelId).toBe("claude-haiku-5-5");
    expect(modelFields(model).provider).toBe("anthropic.messages");
    expect(injected).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("haiku request disables thinking at medium effort with no provider warnings", async () => {
    stubAssistant({ key: KEY_A, baseUrl: "https://ai-gateway.vercel.sh" });
    const double = createMessagesApiDouble(KEY_A);
    const model = createAssistantModel({ fetch: double.fetch });
    const result = await generateText({
      model,
      prompt: "hello",
      maxOutputTokens: 16,
      providerOptions: assistantProviderOptions("claude-haiku-5-5"),
    });
    expect(result.warnings).toEqual([]);
    expect(result.text).toBe("ok");
    expect(double.requests).toHaveLength(1);
    const body = double.requests[0]?.body;
    expect(body?.thinking).toEqual({ type: "disabled" });
    expect(body?.output_config).toEqual({ effort: "medium" });
    expect(body?.temperature).toBeUndefined();
    expect(body?.top_p).toBeUndefined();
    expect(body?.top_k).toBeUndefined();
  });

  it("sonnet request sends no thinking option and gets no provider warnings", async () => {
    stubAssistant({ model: "claude-sonnet-5-5", key: KEY_A });
    const double = createMessagesApiDouble(KEY_A);
    const model = createAssistantModel({ fetch: double.fetch });
    const result = await generateText({
      model,
      prompt: "hello",
      maxOutputTokens: 16,
      providerOptions: assistantProviderOptions("claude-sonnet-5-5"),
    });
    expect(result.warnings).toEqual([]);
    const body = double.requests[0]?.body;
    expect(body?.model).toBe("claude-sonnet-5-5");
    expect(body?.thinking).toBeUndefined();
    expect(body?.output_config).toEqual({ effort: "medium" });
  });

  it("requests carry no sampling parameters, and a caller's temperature is dropped with a warning", async () => {
    stubAssistant({ key: KEY_A });
    const double = createMessagesApiDouble(KEY_A);
    const model = createAssistantModel({ fetch: double.fetch });
    const result = await generateText({
      model,
      prompt: "hello",
      maxOutputTokens: 16,
      temperature: 0.2,
      providerOptions: assistantProviderOptions("claude-haiku-5-5"),
    });
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(double.requests[0]?.body?.temperature).toBeUndefined();
  });

  it("sends only to api.anthropic.com with the Anthropic key, ignoring ANTHROPIC_BASE_URL and gateway credentials", async () => {
    stubAssistant({
      key: KEY_A,
      baseUrl: "https://ai-gateway.vercel.sh",
      gateway: "gateway-secret",
      oidc: "oidc-secret",
      vercel: "1",
    });
    const double = createMessagesApiDouble(KEY_A);
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const model = createAssistantModel({ fetch: double.fetch });
    expect(modelFields(model).provider).toBe("anthropic.messages");
    expect(modelFields(model).modelId).toBe("claude-haiku-5-5");
    await generateText({
      model,
      prompt: "hello",
      maxOutputTokens: 16,
      providerOptions: assistantProviderOptions("claude-haiku-5-5"),
    });
    expect(globalFetch).not.toHaveBeenCalled();
    const request = double.requests[0];
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers["x-api-key"]).toBe(KEY_A);
    expect(request?.headers.authorization).toBeUndefined();
    expect(request?.body?.model).toBe("claude-haiku-5-5");
  });

  it("an empty ANTHROPIC_BASE_URL does not break model creation", async () => {
    stubAssistant({ key: KEY_A, baseUrl: "" });
    const double = createMessagesApiDouble(KEY_A);
    const model = createAssistantModel({ fetch: double.fetch });
    await generateText({
      model,
      prompt: "hello",
      maxOutputTokens: 16,
      providerOptions: assistantProviderOptions("claude-haiku-5-5"),
    });
    expect(double.requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("a rejected key is reported once and not retried", async () => {
    stubAssistant({ key: KEY_A });
    const double = createMessagesApiDouble("some-other-key");
    const model = createAssistantModel({ fetch: double.fetch });
    const error = await generateText({
      model,
      prompt: "hello",
      maxOutputTokens: 16,
      providerOptions: assistantProviderOptions("claude-haiku-5-5"),
    }).catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    if (APICallError.isInstance(error)) expect(error.statusCode).toBe(401);
    expect(double.requests).toHaveLength(1);
  });

  it("no-argument factory sends the same direct Anthropic request for both models", async () => {
    const seen: Array<{ url: string; model: unknown; key: string | undefined; authorization: string | undefined }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      const text = typeof init?.body === "string" ? init.body : "";
      const body = text ? (JSON.parse(text) as { model?: string }) : {};
      seen.push({
        url,
        model: body.model,
        key: headers.get("x-api-key") ?? undefined,
        authorization: headers.get("authorization") ?? undefined,
      });
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      });
    }) as typeof fetch;
    try {
      stubAssistant({
        key: KEY_A,
        baseUrl: "   ",
        gateway: "gateway-secret",
        oidc: "oidc-secret",
        vercel: "1",
      });
      const haiku = createAssistantModel();
      stubAssistant({
        model: "claude-sonnet-5-5",
        key: KEY_B,
        baseUrl: "https://evil.example",
        gateway: "gateway-secret",
        oidc: "oidc-secret",
        vercel: "1",
      });
      const sonnet = createAssistantModel();
      const haikuOptions = assistantProviderOptions("claude-haiku-5-5");
      const sonnetOptions = assistantProviderOptions("claude-sonnet-5-5");
      const [haikuResult, sonnetResult] = await Promise.all([
        generateText({
          model: haiku,
          prompt: "hello",
          maxOutputTokens: 16,
          providerOptions: haikuOptions,
        }),
        generateText({
          model: sonnet,
          prompt: "hello",
          maxOutputTokens: 16,
          providerOptions: sonnetOptions,
        }),
      ]);
      expect(haikuResult.warnings).toEqual([]);
      expect(sonnetResult.warnings).toEqual([]);
      expect(haikuResult.text).toBe("ok");
      expect(sonnetResult.text).toBe("ok");
      expect(seen.map((row) => row.url)).toEqual([
        "https://api.anthropic.com/v1/messages",
        "https://api.anthropic.com/v1/messages",
      ]);
      expect(seen.map((row) => row.model).sort()).toEqual([
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
      ]);
      expect(seen.map((row) => row.key).sort()).toEqual([KEY_A, KEY_B]);
      expect(seen.every((row) => row.authorization === undefined)).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("created models retain credentials model and transport across interleaved requests", async () => {
    stubAssistant({ key: KEY_A });
    const haikuDouble = createMessagesApiDouble(KEY_A);
    let releaseHaiku: (response: Response) => void = () => {};
    let releaseSonnet: (response: Response) => void = () => {};
    const haikuFetch: typeof fetch = (input, init) =>
      new Promise((resolve) => {
        releaseHaiku = resolve;
        void haikuDouble.fetch(input, init);
      });
    const sonnetDouble = createMessagesApiDouble(KEY_B);
    const sonnetFetch: typeof fetch = (input, init) =>
      new Promise((resolve) => {
        releaseSonnet = resolve;
        void sonnetDouble.fetch(input, init);
      });
    const haiku = createAssistantModel({ fetch: haikuFetch });
    stubAssistant({ model: "claude-sonnet-5-5", key: KEY_B });
    const sonnet = createAssistantModel({ fetch: sonnetFetch });
    const pending = Promise.all([
      generateText({
        model: haiku,
        prompt: "hello",
        maxOutputTokens: 16,
        providerOptions: assistantProviderOptions("claude-haiku-5-5"),
      }),
      generateText({
        model: sonnet,
        prompt: "hello",
        maxOutputTokens: 16,
        providerOptions: assistantProviderOptions("claude-sonnet-5-5"),
      }),
    ]);
    await vi.waitFor(() => {
      expect(haikuDouble.requests.length + sonnetDouble.requests.length).toBe(2);
    });
    releaseSonnet(Response.json({
      id: "msg_s",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    releaseHaiku(Response.json({
      id: "msg_h",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await pending;
    expect(haikuDouble.requests[0]?.headers["x-api-key"]).toBe(KEY_A);
    expect(haikuDouble.requests[0]?.body?.model).toBe("claude-haiku-5-5");
    expect(sonnetDouble.requests[0]?.headers["x-api-key"]).toBe(KEY_B);
    expect(sonnetDouble.requests[0]?.body?.model).toBe("claude-sonnet-5-5");
  });

  it("provider options do not share mutable nested state", () => {
    const first = assistantProviderOptions("claude-haiku-5-5");
    first.anthropic.effort = "max" as "medium";
    if (first.anthropic.thinking) first.anthropic.thinking.type = "enabled" as "disabled";
    const second = assistantProviderOptions("claude-haiku-5-5");
    expect(second.anthropic.effort).toBe("medium");
    expect(second.anthropic.thinking).toEqual({ type: "disabled" });
    const sonnet = assistantProviderOptions("claude-sonnet-5-5");
    expect(sonnet.anthropic).not.toHaveProperty("thinking");
    expect(assistantProviderOptions("claude-sonnet-5-5").anthropic.effort).toBe("medium");
  });

  it("missing Anthropic credentials never fall back to Vercel credentials", () => {
    const injected = vi.fn<typeof fetch>();
    stubAssistant({
      model: "gpt-4o",
      gateway: "gateway-secret",
      oidc: "oidc-secret",
      vercel: "1",
    });
    expect(() => createAssistantModel({ fetch: injected })).toThrow(AssistantConfigError);
    stubAssistant({
      gateway: "gateway-secret",
      oidc: "oidc-secret",
      vercel: "1",
    });
    expect(() => createAssistantModel({ fetch: injected })).toThrow(AssistantConfigError);
    expect(injected).not.toHaveBeenCalled();
  });
});
