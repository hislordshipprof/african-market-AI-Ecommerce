import { stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { groundingTransform } from "./grounding";

const usage = {
  inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};

function streamOf(chunks: Array<Record<string, unknown>>) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("grounding stream", () => {
  it("an amount split across deltas never reaches the client", async () => {
    const strips: string[] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        const chunks = call === 1
          ? [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "show_products",
                input: JSON.stringify({ listing_ids: ["egusi"] }),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "That is $" },
              { type: "text-delta", id: "text-1", delta: "12.9" },
              { type: "text-delta", id: "text-1", delta: "9 and $" },
              { type: "text-delta", id: "text-1", delta: "7.00" },
              { type: "text-end", id: "text-1" },
              { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
            ];
        return { stream: streamOf(chunks) };
      },
    });
    const result = streamText({
      model,
      prompt: "price",
      stopWhen: stepCountIs(4),
      tools: {
        show_products: tool({
          description: "Show a product",
          inputSchema: z.object({ listing_ids: z.array(z.string()) }),
          execute: async () => ({ priceCents: 1299 }),
        }),
      },
      experimental_transform: groundingTransform({ onStrip: (amount) => strips.push(amount) }),
    });
    const chunks: unknown[] = [];
    for await (const chunk of result.toUIMessageStream()) chunks.push(chunk);
    const text = chunks
      .filter((chunk): chunk is { type: string; delta: string } =>
        !!chunk && typeof chunk === "object" && (chunk as { type?: string }).type === "text-delta")
      .map((chunk) => chunk.delta)
      .join("");
    expect(text).toBe("I couldn't confirm that price.");
    expect(chunks.some((chunk) => JSON.stringify(chunk).includes("7.00"))).toBe(false);
    expect(strips).toEqual(["$7.00"]);
  });

  it("tool parts keep their order", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-1", toolName: "show_products", input: "{\"listing_ids\":[\"a\"]}" },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
        ]),
      }),
    });
    const result = streamText({
      model,
      prompt: "show",
      tools: {
        show_products: tool({
          description: "Show",
          inputSchema: z.object({ listing_ids: z.array(z.string()) }),
          execute: async () => ({ priceCents: 100 }),
        }),
      },
      experimental_transform: groundingTransform(),
      stopWhen: stepCountIs(1),
    });
    const plain = streamText({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: streamOf([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "call-1", toolName: "show_products", input: "{\"listing_ids\":[\"a\"]}" },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
          ]),
        }),
      }),
      prompt: "show",
      tools: {
        show_products: tool({
          description: "Show",
          inputSchema: z.object({ listing_ids: z.array(z.string()) }),
          execute: async () => ({ priceCents: 100 }),
        }),
      },
      stopWhen: stepCountIs(1),
    });
    const chunks: Array<{ type: string; toolCallId?: string; output?: unknown }> = [];
    for await (const chunk of result.toUIMessageStream()) {
      const part = chunk as { type?: string; toolCallId?: string; output?: unknown };
      if (part.type) chunks.push({ type: part.type, toolCallId: part.toolCallId, output: part.output });
    }
    const bare: typeof chunks = [];
    for await (const chunk of plain.toUIMessageStream()) {
      const part = chunk as { type?: string; toolCallId?: string; output?: unknown };
      if (part.type?.startsWith("tool-")) bare.push({ type: part.type, toolCallId: part.toolCallId, output: part.output });
    }
    const outputs = chunks.filter((chunk) => chunk.type === "tool-output-available");
    const inputAt = chunks.findIndex((chunk) => chunk.type === "tool-input-available" && chunk.toolCallId === "call-1");
    const outputAt = chunks.findIndex((chunk) => chunk.type === "tool-output-available" && chunk.toolCallId === "call-1");
    expect(inputAt).toBeGreaterThanOrEqual(0);
    expect(outputAt).toBeGreaterThan(inputAt);
    expect(outputs).toEqual([
      expect.objectContaining({ toolCallId: "call-1", output: { priceCents: 100 } }),
    ]);
    expect(chunks.filter((chunk) => chunk.type.startsWith("tool-"))).toEqual(bare);
  });

  it("a rejected tool call cannot whitelist an invented price", async () => {
    let executions = 0;
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        const chunks = call === 1
          ? [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call-bad",
                toolName: "search_catalog",
                input: JSON.stringify({ query: "egusi", limit: 999, priceCents: 777 }),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "It costs $7.77." },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
            ];
        return { stream: streamOf(chunks) };
      },
    });
    const result = streamText({
      model,
      prompt: "price",
      stopWhen: stepCountIs(3),
      tools: {
        search_catalog: tool({
          description: "Search",
          inputSchema: z.object({ query: z.string(), limit: z.number().max(10) }),
          execute: async () => {
            executions += 1;
            return { items: [] };
          },
        }),
      },
      experimental_transform: groundingTransform(),
    });
    let text = "";
    for await (const chunk of result.toUIMessageStream()) {
      if ((chunk as { type?: string }).type === "text-delta") text += (chunk as { delta: string }).delta;
    }
    expect(executions).toBe(0);
    expect(text).toBe("I couldn't confirm that price.");
    expect(text).not.toContain("7.77");
  });

  it("a successful tool result cannot whitelist cents from its input", async () => {
    let call = 0;
    const strips: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        const chunks = call === 1
          ? [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call-in",
                toolName: "show_products",
                input: JSON.stringify({ priceCents: 777, listing_ids: ["egusi"] }),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "Output is $12." },
              { type: "text-delta", id: "t", delta: "99. Input said $7.77." },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
            ];
        return { stream: streamOf(chunks) };
      },
    });
    const result = streamText({
      model,
      prompt: "price",
      stopWhen: stepCountIs(3),
      tools: {
        show_products: tool({
          description: "Show",
          inputSchema: z.object({ priceCents: z.number(), listing_ids: z.array(z.string()) }),
          execute: async () => ({ priceCents: 1299, variantId: "egusi" }),
        }),
      },
      experimental_transform: groundingTransform({ onStrip: (amount) => strips.push(amount) }),
    });
    let text = "";
    for await (const chunk of result.toUIMessageStream()) {
      if ((chunk as { type?: string }).type === "text-delta") text += (chunk as { delta: string }).delta;
    }
    expect(text).toBe("Output is $12.99. I couldn't confirm that price.");
    expect(text).not.toContain("7.77");
    expect(text).not.toContain("(see card)");
    expect(strips).toEqual(["$7.77"]);
  });

  it("a chunked foreign amount cannot pass as an allowed dollar price", async () => {
    const strips: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Real is $10.99. " },
          { type: "text-delta", id: "t", delta: "CAD $" },
          { type: "text-delta", id: "t", delta: "10.99 is not." },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
        ]),
      }),
    });
    const result = streamText({
      model,
      prompt: "currency",
      experimental_transform: groundingTransform({
        getAllowedCents: () => new Set([1099]),
        onStrip: (amount) => strips.push(amount),
      }),
    });
    let text = "";
    const raw: string[] = [];
    for await (const chunk of result.toUIMessageStream()) {
      raw.push(JSON.stringify(chunk));
      if ((chunk as { type?: string }).type === "text-delta") text += (chunk as { delta: string }).delta;
    }
    expect(text).toBe("Real is $10.99. I couldn't confirm that price.");
    expect(strips).toEqual(["CAD $10.99"]);
    expect(raw.join("\n")).not.toContain("CAD $10.99");
  });

  it("interleaved text blocks are grounded separately", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "a" },
          { type: "text-delta", id: "a", delta: "$4.50" },
          { type: "text-end", id: "a" },
          { type: "text-start", id: "b" },
          { type: "text-delta", id: "b", delta: "$9.00" },
          { type: "text-end", id: "b" },
          { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
        ]),
      }),
    });
    const result = streamText({
      model,
      prompt: "two",
      experimental_transform: groundingTransform({ getAllowedCents: () => new Set([450]) }),
    });
    let text = "";
    for await (const chunk of result.toUIMessageStream()) {
      if ((chunk as { type?: string }).type === "text-delta") text += (chunk as { delta: string }).delta;
    }
    expect(text).toBe("$4.50I couldn't confirm that price.");
  });

  it("overlapping text blocks keep each block's own buffer", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "tool-result", toolCallId: "call-1", toolName: "show_products", output: { priceCents: 300 } },
          { type: "text-start", id: "a" },
          { type: "text-delta", id: "a", delta: "$3.00" },
          { type: "text-start", id: "b" },
          { type: "text-delta", id: "b", delta: "$4.00" },
          { type: "text-end", id: "a" },
          { type: "text-delta", id: "b", delta: " and $999.00" },
          { type: "text-end", id: "b" },
          { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
        ]),
      }),
    });
    const result = streamText({
      model,
      prompt: "overlap",
      experimental_transform: groundingTransform({ getAllowedCents: () => new Set([300]) }),
    });
    const chunks: Array<{ type: string; delta?: string }> = [];
    for await (const chunk of result.toUIMessageStream()) {
      const part = chunk as { type?: string; delta?: string };
      if (part.type) chunks.push({ type: part.type, delta: part.delta });
    }
    const text = chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta ?? "").join("");
    const toolAt = chunks.findIndex((chunk) => chunk.type.startsWith("tool-"));
    const textAt = chunks.findIndex((chunk) => chunk.type === "text-delta");
    expect(toolAt).toBeGreaterThanOrEqual(0);
    expect(textAt).toBeGreaterThan(toolAt);
    expect(text).toBe("$3.00I couldn't confirm that price.");
    expect(chunks.map((chunk) => JSON.stringify(chunk)).join("\n")).not.toContain("999");
    expect(chunks.map((chunk) => JSON.stringify(chunk)).join("\n")).not.toContain("$4.00");
  });

  it("an error mid-text never emits raw text", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "a" },
          { type: "text-delta", id: "a", delta: "$7.00 secret" },
          { type: "error", error: new Error("provider failed") },
          { type: "finish", finishReason: { unified: "error", raw: "error" }, usage },
        ]),
      }),
    });
    const result = streamText({
      model,
      prompt: "boom",
      experimental_transform: groundingTransform(),
    });
    const raw: string[] = [];
    for await (const chunk of result.toUIMessageStream()) raw.push(JSON.stringify(chunk));
    expect(raw.join("\n")).not.toContain("7.00");
    expect(raw.join("\n")).not.toContain("secret");
  });

  it("reports each strip once", async () => {
    const strips: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "a" },
          { type: "text-delta", id: "a", delta: "$5.00 and $6.00" },
          { type: "text-end", id: "a" },
          { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
        ]),
      }),
    });
    const result = streamText({
      model,
      prompt: "strip",
      experimental_transform: groundingTransform({ onStrip: (amount) => strips.push(amount) }),
    });
    await result.consumeStream();
    expect(strips).toEqual(["$5.00", "$6.00"]);

    const seamStrips: string[] = [];
    const seam = streamText({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: streamOf([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "a" },
            { type: "text-delta", id: "a", delta: "- Egusi and palm oil: $10.99 $7.77\nEgusi costs $\u00a07.77." },
            { type: "text-end", id: "a" },
            { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
          ]),
        }),
      }),
      prompt: "adjacent",
      experimental_transform: groundingTransform({
        historyUnitPrices: [{ key: "variant:egusi", cents: 1099 }],
        onStrip: (amount) => seamStrips.push(amount),
      }),
    });
    const seamText = await seam.text;
    expect(seamText).toBe(`- Egusi and palm oil: $10.99 price not confirmed\nI couldn't confirm that price.`);
    expect(seamText).not.toContain("7.77");
    expect(seamStrips).toEqual(["$7.77", "$\u00a07.77"]);

    const splitStrips: string[] = [];
    const split = streamText({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: streamOf([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "- Egusi and palm: $10.99 USD" },
            { type: "text-delta", id: "t", delta: "7.77" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
          ]),
        }),
      }),
      prompt: "split",
      experimental_transform: groundingTransform({
        historyUnitPrices: [{ key: "variant:egusi", cents: 1099 }],
        onStrip: (amount) => splitStrips.push(amount),
      }),
    });
    expect(await split.text).toBe("- Egusi and palm: $10.99 price not confirmed");
    expect(splitStrips).toEqual(["USD7.77"]);
  });
});
