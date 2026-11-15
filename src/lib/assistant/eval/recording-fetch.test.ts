import { describe, expect, it } from "vitest";
import { recordingFetch, type RecordedExchange } from "./recording-fetch";

function sse(events: unknown[]): typeof fetch {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function record(events: unknown[]): Promise<RecordedExchange> {
  const sink: RecordedExchange[] = [];
  const response = await recordingFetch(sse(events), sink)("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
  await response.text();
  await sink[0]!.done;
  return sink[0]!;
}

const start = { type: "message_start", message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } } };

describe("recording fetch usage", () => {
  it("a stream cut before message_delta keeps the output tokens message_start reported", async () => {
    const exchange = await record([start]);
    expect(exchange.usage?.outputTokens?.total).toBe(2);
    expect(exchange.unresolvedUsage).toBe(true);
  });

  it("message_delta counts replace the start counts, input and cache included", async () => {
    const exchange = await record([start, {
      type: "message_delta",
      usage: { input_tokens: 120, cache_creation_input_tokens: 5, cache_read_input_tokens: 40, output_tokens: 30 },
    }]);
    expect(exchange.usage?.inputTokens).toEqual({ noCache: 120, cacheRead: 40, cacheWrite: 5, total: 165 });
    expect(exchange.usage?.outputTokens?.total).toBe(30);
    expect(exchange.unresolvedUsage).toBe(false);
  });

  it("a delta with only output tokens keeps the start input counts", async () => {
    const exchange = await record([start, { type: "message_delta", usage: { output_tokens: 9 } }]);
    expect(exchange.usage?.inputTokens?.noCache).toBe(100);
    expect(exchange.usage?.outputTokens?.total).toBe(9);
  });

  it("a finished stream whose start and delta omit usage is unresolved, not free", async () => {
    const exchange = await record([{ type: "message_start", message: {} }, { type: "message_delta", delta: { stop_reason: "end_turn" } }]);
    expect(exchange.usage).toBeNull();
    expect(exchange.unresolvedUsage).toBe(true);
  });
});
