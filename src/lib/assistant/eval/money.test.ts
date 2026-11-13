import { describe, expect, it } from "vitest";
import { callCostMicros } from "../cost";
import { anthropicUsage, recordingFetch, type RecordedExchange } from "./recording-fetch";
import { usdAmountsInText } from "./money";

describe("shopper assistant eval money", () => {
  it("parses cent denominations and cache usage without subtracting them twice", async () => {
    expect(usdAmountsInText("99 cents")).toEqual([99]);
    expect(usdAmountsInText("99¢")).toEqual([99]);
    expect(usdAmountsInText("It is $99.")).toEqual([9900]);

    expect(usdAmountsInText("Your cart total is 1,362 cents, including a service fee of 99 cents.")).toEqual([1362, 99]);
    expect(usdAmountsInText("1362 cents")).toEqual([1362]);
    expect(usdAmountsInText("$13.62")).toEqual([1362]);
    // The dollar forms do not read thousands separators; this pins that they are unchanged.
    expect(usdAmountsInText("$1,362.00")).toEqual([100]);

    const usage = anthropicUsage(1000, 3000, 0, 10);
    expect(callCostMicros("claude-haiku-5-5", usage ?? {})).toBe(BigInt(135));

    const seen: RecordedExchange[] = [];
    const fetchImpl = recordingFetch(async () => new Response(`data: ${JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 1000, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 } },
    })}\n\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 10 } })}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }), seen);
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
    await response.text();
    await seen[0]?.done;
    expect(callCostMicros("claude-haiku-5-5", seen[0]?.usage ?? {})).toBe(BigInt(135));
  });
});
