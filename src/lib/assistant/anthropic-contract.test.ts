import { APICallError, generateText, stepCountIs, streamText, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { appUserQuery } from "../db";
import { callCostMicros } from "./cost";
import { createFakeAnthropicFetch } from "./messages-api-double";
import { assistantProviderOptions, createAssistantModel } from "./model";
import { failNextSpendWrites, utcDay } from "./spend";

const hasDb = !!process.env.DATABASE_URL;
const MODEL = "claude-haiku-5-5";
const KEY = "sk-ant-test";

const ping = tool({
  description: "Reply pong.",
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});

async function todayTotal(): Promise<bigint> {
  const day = utcDay(new Date());
  const rows = await appUserQuery((tx) =>
    tx.$queryRaw<Array<{ cost: bigint }>>`
      SELECT COALESCE(SUM(cost_micros), 0) AS cost
      FROM assistant_spend_days
      WHERE day = CAST(${day} AS date)
    `,
  );
  return BigInt(rows[0]?.cost ?? 0);
}

function usage(input: number, output: number, cacheWrite = 0, cacheRead = 0) {
  return {
    inputTokens: { total: input + cacheWrite + cacheRead, noCache: input, cacheWrite, cacheRead },
    outputTokens: { total: output },
  };
}

describe.skipIf(!hasDb)("anthropic adapter contract", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    failNextSpendWrites(0);
  });

  it("records every step of a multi-step turn through the real Anthropic adapter", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", MODEL);
    const fake = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [
        { kind: "tool", toolName: "ping", toolInput: {}, inputTokens: 100, outputTokens: 10 },
        { kind: "tool", toolName: "ping", toolInput: {}, inputTokens: 120, outputTokens: 8 },
        { kind: "text", text: "done", inputTokens: 140, outputTokens: 6 },
      ],
    });
    const before = await todayTotal();
    const result = streamText({
      model: createAssistantModel({ fetch: fake.fetch }),
      tools: { ping },
      stopWhen: stepCountIs(4),
      prompt: "go",
      maxOutputTokens: 64,
      providerOptions: assistantProviderOptions(MODEL),
    });
    const text = await result.text;
    expect(text).toBe("done");
    expect(fake.requests).toHaveLength(3);
    const expected =
      callCostMicros(MODEL, usage(100, 10)) +
      callCostMicros(MODEL, usage(120, 8)) +
      callCostMicros(MODEL, usage(140, 6));
    expect((await todayTotal()) - before).toBe(expected);
  });

  it("records generateText calls", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", MODEL);
    const fake = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{ kind: "text", text: "eval", inputTokens: 20, outputTokens: 2 }],
    });
    const before = await todayTotal();
    const result = await generateText({
      model: createAssistantModel({ fetch: fake.fetch }),
      prompt: "grade",
      maxOutputTokens: 16,
      providerOptions: assistantProviderOptions(MODEL),
    });
    expect(result.text).toBe("eval");
    expect((await todayTotal()) - before).toBe(callCostMicros(MODEL, usage(20, 2)));
  });

  it("parses cache read and write tokens into the cost", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", MODEL);
    const fake = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{
        kind: "text",
        text: "cached",
        inputTokens: 10_000,
        cacheWriteTokens: 2_000,
        cacheReadTokens: 8_000,
        outputTokens: 1_000,
      }],
    });
    const before = await todayTotal();
    await generateText({
      model: createAssistantModel({ fetch: fake.fetch }),
      prompt: "hi",
      maxOutputTokens: 32,
      providerOptions: assistantProviderOptions(MODEL),
    });
    expect((await todayTotal()) - before).toBe(BigInt(1830));
  });

  it("records nothing when the stream errors before finish", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", MODEL);
    const fake = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{ kind: "error", inputTokens: 50, outputTokens: 5 }],
    });
    const before = await todayTotal();
    const result = streamText({
      model: createAssistantModel({ fetch: fake.fetch }),
      prompt: "hi",
      maxOutputTokens: 32,
      providerOptions: assistantProviderOptions(MODEL),
    });
    const parts: Array<{ type: string; error?: unknown }> = [];
    let thrown: unknown = null;
    try {
      for await (const part of result.fullStream) {
        parts.push(part as { type: string; error?: unknown });
      }
    } catch (error) {
      thrown = error;
    }
    const errorPart = parts.find((part) => part.type === "error");
    expect(thrown ?? errorPart?.error).toBeTruthy();
    expect(await todayTotal()).toBe(before);
  });

  it("retries a ledger write once", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", MODEL);
    failNextSpendWrites(1);
    const fake = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{ kind: "text", text: "once", inputTokens: 10, outputTokens: 1 }],
    });
    const before = await todayTotal();
    const result = await generateText({
      model: createAssistantModel({ fetch: fake.fetch }),
      prompt: "hi",
      maxOutputTokens: 8,
      providerOptions: assistantProviderOptions(MODEL),
    });
    expect(result.text).toBe("once");
    expect((await todayTotal()) - before).toBe(callCostMicros(MODEL, usage(10, 1)));
  });

  it("logs and continues when the ledger write fails twice", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", MODEL);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    failNextSpendWrites(2);
    const fake = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{ kind: "text", text: "kept", inputTokens: 10, outputTokens: 1 }],
    });
    const before = await todayTotal();
    const result = await generateText({
      model: createAssistantModel({ fetch: fake.fetch }),
      prompt: "hi",
      maxOutputTokens: 8,
      providerOptions: assistantProviderOptions(MODEL),
    });
    expect(result.text).toBe("kept");
    expect(await todayTotal()).toBe(before);
    expect(errors.some((line) => line.includes("spend not recorded"))).toBe(true);
  });

  it("fake Anthropic rejects more than four cache breakpoints, a bad tool name and a missing key", async () => {
    const fake = createFakeAnthropicFetch({ expectedKey: KEY });
    const headers = {
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    const parts = Array.from({ length: 5 }, () => ({
      type: "text",
      text: "x",
      cache_control: { type: "ephemeral", ttl: "5m" },
    }));
    const tooMany = await fake.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8,
        messages: [{ role: "user", content: parts }],
      }),
    });
    expect(tooMany.status).toBe(400);

    const badName = await fake.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "bad name", input_schema: { type: "object" } }],
      }),
    });
    expect(badName.status).toBe(400);

    const missing = await fake.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { ...headers, "x-api-key": "" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(missing.status).toBe(401);

    vi.stubEnv("ANTHROPIC_API_KEY", "wrong-key");
    vi.stubEnv("ASSISTANT_MODEL", MODEL);
    const rejected = createFakeAnthropicFetch({ expectedKey: KEY, steps: [{ kind: "text", text: "no" }] });
    const attempt = generateText({
      model: createAssistantModel({ fetch: rejected.fetch }),
      prompt: "hi",
      maxOutputTokens: 8,
      providerOptions: assistantProviderOptions(MODEL),
    });
    await expect(attempt).rejects.toSatisfy((error: unknown) =>
      APICallError.isInstance(error) && error.statusCode === 401,
    );
  });
});
