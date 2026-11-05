import { E2E_FAKE_ANTHROPIC_KEY } from "./contract";
import { judgeMessagesRequest } from "./messages-api-double";

type Block = Record<string, unknown>;

export type ScriptStep =
  | { kind: "text"; text: string; delayMs?: number }
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "error" }
  | { kind: "cut" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function blocksOf(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function textOf(block: Block): string {
  return typeof block.text === "string" ? block.text : "";
}

/** The latest human sentence, ignoring tool-result-only user messages. */
export function currentTurn(messages: unknown): { text: string; results: Array<{ name: string; output: unknown }>; length: number } {
  const list = Array.isArray(messages) ? messages : [];
  let textIndex = -1;
  let text = "";
  list.forEach((message, index) => {
    if (!isRecord(message) || message.role !== "user") return;
    const textBlock = blocksOf(message.content).find((block) => block.type === "text");
    if (textBlock) {
      textIndex = index;
      text = textOf(textBlock);
    } else if (typeof message.content === "string") {
      textIndex = index;
      text = message.content;
    }
  });
  const names = new Map<string, string>();
  const results: Array<{ name: string; output: unknown }> = [];
  for (const message of list.slice(textIndex + 1)) {
    if (!isRecord(message)) continue;
    for (const block of blocksOf(message.content)) {
      if (message.role === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
        names.set(block.id, typeof block.name === "string" ? block.name : "");
      }
      if (message.role === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        results.push({
          name: names.get(block.tool_use_id) ?? "",
          output: parseOutput(block.content),
        });
      }
    }
  }
  return { text, results, length: list.length };
}

function parseOutput(content: unknown): unknown {
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  const text = blocksOf(content).map(textOf).join("");
  if (!text) return content;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function itemsOf(output: unknown): Array<{ listingId?: string; variantId?: string }> {
  if (!isRecord(output) || !Array.isArray(output.items)) return [];
  return output.items.filter(isRecord);
}

export const WIDE_LAYOUT_TOKEN = "W".repeat(60);
export const WIDE_LAYOUT_STORE = `MamaNgozi${"S".repeat(48)}`;

export function wideLayoutText(): string {
  return `See https://example.com/assistant/wide-layout and ${WIDE_LAYOUT_TOKEN} at ${WIDE_LAYOUT_STORE}.`;
}

export function scriptStep(messages: unknown): ScriptStep {
  const turn = currentTurn(messages);
  const text = turn.text.toLowerCase();
  const last = turn.results.at(-1);
  if (!last) return openingStep(text, turn.text, messages);
  if (last.name === "search_catalog") {
    const items = itemsOf(last.output);
    if (text.includes("choices")) {
      const options = items.slice(0, 2).flatMap((item) => item.listingId ? [{ listing_id: item.listingId }] : []);
      if (options.length < 2) return { kind: "text", text: "I could not find two choices." };
      return { kind: "tool", name: "offer_choices", input: { options } };
    }
    if (text.includes("pictures")) {
      return {
        kind: "tool",
        name: "show_products",
        input: { listing_ids: items.flatMap((item) => item.listingId ? [item.listingId] : []).slice(0, 2) },
      };
    }
    const first = items[0];
    if (!first?.variantId) return { kind: "text", text: "Here is what I found." };
    const qty = /\btwo\b|\b2\b/.test(text) ? 2 : 1;
    const add = [{ variant_id: first.variantId, qty }];
    if (text.includes("two lines") && items[1]?.variantId) {
      add.push({ variant_id: items[1].variantId as string, qty: 1 });
    }
    return { kind: "tool", name: "add_to_cart", input: { items: add } };
  }
  if (last.name === "offer_choices") return { kind: "text", text: "Pick one." };
  if (last.name === "get_cart_summary") return { kind: "text", text: "Here is your basket." };
  if (last.name === "show_products" || last.name === "add_to_cart") {
    if (text.includes("wide layout")) return { kind: "text", text: wideLayoutText() };
    return { kind: "text", text: "Here is what I found." };
  }
  return { kind: "text", text: "Here is what I found." };
}

function retriedFailure(messages: unknown, needle: string): boolean {
  const list = Array.isArray(messages) ? messages : [];
  let lastUser = -1;
  list.forEach((message, index) => {
    if (!isRecord(message) || message.role !== "user") return;
    const text = typeof message.content === "string"
      ? message.content
      : blocksOf(message.content).map(textOf).join("");
    if (text.toLowerCase().includes(needle)) lastUser = index;
  });
  if (lastUser < 0) return false;
  return list.slice(lastUser + 1).some((message) => isRecord(message) && message.role === "assistant");
}

function openingStep(lower: string, raw: string, messages: unknown): ScriptStep {
  if (lower.includes("overload") || lower.includes("mid-stream")) {
    const needle = lower.includes("mid-stream") ? "mid-stream" : "overload";
    if (retriedFailure(messages, needle)) return { kind: "text", text: "Recovered after the interruption." };
    return { kind: "error" };
  }
  if (lower.includes("cut the stream")) return { kind: "cut" };
  if (lower.includes("hold please")) return { kind: "text", text: "Finished waiting.", delayMs: 2500 };
  if (lower.includes("$1.00") || lower.includes("stray price")) return { kind: "text", text: "That is $1.00." };
  if (lower.includes("html please")) return { kind: "text", text: 'See <img onerror="alert(1)"> and [a](http://evil.test).' };
  if (lower.includes("summary") || lower.includes("basket")) return { kind: "tool", name: "get_cart_summary", input: {} };
  if (lower.includes("choices")) return { kind: "tool", name: "search_catalog", input: { query: "yam" } };
  if (lower.includes("egusi") || lower.includes("pictures") || lower.includes("show me")) {
    const query = lower.includes("egusi") ? "egusi" : raw.trim().slice(0, 100);
    return { kind: "tool", name: "search_catalog", input: { query } };
  }
  return { kind: "text", text: "Here is what I found." };
}

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function eventsFor(step: ScriptStep, model: string, messagesLength: number): unknown[] {
  const start = {
    type: "message_start",
    message: {
      id: "msg_fake",
      model,
      role: "assistant",
      usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  if (step.kind === "error") {
    return [
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ];
  }
  if (step.kind === "cut") {
    return [
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
    ];
  }
  if (step.kind === "tool") {
    const id = `toolu_${step.name}_${messagesLength}_0`;
    const json = JSON.stringify(step.input);
    const mid = Math.max(1, Math.ceil(json.length / 2));
    return [
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id, name: step.name },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, mid) } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(mid) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ];
  }
  return [
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return await new Response(raw as BodyInit).text();
}

function headerMap(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries = headers instanceof Headers ? headers.entries() : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) out[key.toLowerCase()] = value;
  return out;
}

/** Stateless Messages API responder. Each reply depends only on that request. */
export const scriptedAssistantFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = {
    ...headerMap(input instanceof Request ? input.headers : undefined),
    ...headerMap(init?.headers),
  };
  const text = await readBody(input, init);
  let body: Record<string, unknown> | null = null;
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      body = isRecord(parsed) ? parsed : null;
    } catch {
      body = null;
    }
  }
  const verdict = judgeMessagesRequest({
    url,
    method,
    headers,
    body,
    expectedKey: E2E_FAKE_ANTHROPIC_KEY,
  });
  if (verdict) {
    return Response.json(
      { type: "error", error: { type: verdict.errorType, message: verdict.message }, request_id: "req_fake" },
      { status: verdict.status },
    );
  }
  const step = scriptStep(body?.messages);
  if (step.kind === "text" && step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
  const model = String(body?.model ?? "");
  const length = Array.isArray(body?.messages) ? body.messages.length : 0;
  return new Response(sse(eventsFor(step, model, length)), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};
