/**
 * A Messages API stand-in. It rejects the requests Anthropic rejects and
 * records what the real adapter sent. It never opens a network connection.
 */

export interface RecordedMessagesRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export interface MessagesApiDouble {
  fetch: typeof fetch;
  requests: RecordedMessagesRequest[];
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const ALLOWED_MODELS = new Set(["claude-haiku-5-5", "claude-sonnet-5-5"]);

export interface MessagesVerdict {
  status: number;
  errorType: "authentication_error" | "invalid_request_error";
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerMap(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries =
    headers instanceof Headers
      ? headers.entries()
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  for (const [key, value] of entries) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function walkCacheControls(value: unknown, found: Array<Record<string, unknown>>) {
  if (Array.isArray(value)) {
    for (const item of value) walkCacheControls(item, found);
    return;
  }
  if (!isRecord(value)) return;
  if (isRecord(value.cache_control)) found.push(value.cache_control);
  for (const child of Object.values(value)) {
    if (child !== value.cache_control) walkCacheControls(child, found);
  }
}

/** Pure check used by the double and by its self-test, with no adapter in between. */
export function judgeMessagesRequest(args: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  expectedKey: string;
}): MessagesVerdict | null {
  const key = args.headers["x-api-key"];
  if (!key || key !== args.expectedKey) {
    return {
      status: 401,
      errorType: "authentication_error",
      message: "invalid x-api-key",
    };
  }
  let path = "";
  try {
    path = new URL(args.url).pathname;
  } catch {
    path = args.url;
  }
  if (args.method.toUpperCase() !== "POST" || !path.endsWith("/v1/messages")) {
    return {
      status: 400,
      errorType: "invalid_request_error",
      message: "POST /v1/messages is required",
    };
  }
  if (args.headers["anthropic-version"] !== "2023-06-01") {
    return {
      status: 400,
      errorType: "invalid_request_error",
      message: "anthropic-version must be 2023-06-01",
    };
  }
  const contentType = args.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    return {
      status: 400,
      errorType: "invalid_request_error",
      message: "content-type must be application/json",
    };
  }
  const body = args.body;
  if (
    !body ||
    typeof body.model !== "string" ||
    typeof body.max_tokens !== "number" ||
    !Array.isArray(body.messages)
  ) {
    return {
      status: 400,
      errorType: "invalid_request_error",
      message: "model, max_tokens and messages are required",
    };
  }
  if (!ALLOWED_MODELS.has(body.model)) {
    return {
      status: 400,
      errorType: "invalid_request_error",
      message: "unknown model",
    };
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const dynamicSearch = tools.some((item) => isRecord(item) && typeof item.type === "string" && /^web_(search|fetch)_2026/.test(item.type));
  if (dynamicSearch && body.model === "claude-haiku-5-5") {
    return {
      status: 400,
      errorType: "invalid_request_error",
      message: "this web tool version is not supported on claude-haiku-5-5; use web_search_20250305",
    };
  }
  if (
    body.temperature !== undefined ||
    body.top_p !== undefined ||
    body.top_k !== undefined
  ) {
    return {
      status: 400,
      errorType: "invalid_request_error",
      message: "non-default sampling parameters are rejected",
    };
  }
  const thinking = isRecord(body.thinking) ? body.thinking : undefined;
  const thinkingType = typeof thinking?.type === "string" ? thinking.type : undefined;
  const effort = isRecord(body.output_config)
    ? body.output_config.effort
    : undefined;
  const high = effort === "xhigh" || effort === "max";
  if (body.model === "claude-haiku-5-5") {
    if (thinkingType === "enabled" || thinkingType === "between_tools") {
      return {
        status: 400,
        errorType: "invalid_request_error",
        message: `haiku rejects thinking ${thinkingType}`,
      };
    }
    if (thinkingType === "disabled" && high) {
      return {
        status: 400,
        errorType: "invalid_request_error",
        message: "haiku rejects disabled thinking above high effort",
      };
    }
  }
  if (body.model === "claude-sonnet-5-5") {
    if (thinkingType === "disabled" || thinkingType === "enabled") {
      return {
        status: 400,
        errorType: "invalid_request_error",
        message: `sonnet rejects thinking ${thinkingType}`,
      };
    }
    if (thinkingType === "between_tools" && high) {
      return {
        status: 400,
        errorType: "invalid_request_error",
        message: "sonnet rejects between_tools above high effort",
      };
    }
  }
  const controls: Array<Record<string, unknown>> = [];
  walkCacheControls(body, controls);
  if (controls.length > 4) {
    return {
      status: 400,
      errorType: "invalid_request_error",
      message: "at most 4 cache breakpoints",
    };
  }
  for (const control of controls) {
    if (
      control.ttl !== undefined &&
      control.ttl !== "5m" &&
      control.ttl !== "1h"
    ) {
      return {
        status: 400,
        errorType: "invalid_request_error",
        message: "cache_control.ttl must be 5m or 1h",
      };
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
        return {
          status: 400,
          errorType: "invalid_request_error",
          message: "tool name must match ^[a-zA-Z0-9_-]{1,128}$",
        };
      }
    }
  }
  const media = judgeMedia(body);
  if (media) return media;
  return judgeToolHistory(body);
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function judgeMedia(body: Record<string, unknown>): MessagesVerdict | null {
  if (!Array.isArray(body.messages)) return null;
  for (const message of body.messages) {
    if (!isRecord(message)) continue;
    for (const block of contentBlocks(message.content)) {
      if (block.type === "image" && isRecord(block.source) && block.source.type === "base64") {
        const mediaType = typeof block.source.media_type === "string" ? block.source.media_type : "";
        const data = typeof block.source.data === "string" ? block.source.data : "";
        if (!IMAGE_TYPES.has(mediaType)) {
          return { status: 400, errorType: "invalid_request_error", message: "unsupported image media_type" };
        }
        const bytes = strictBase64(data);
        if (!bytes) return { status: 400, errorType: "invalid_request_error", message: "image base64 does not decode" };
        if (!imageMagic(bytes, mediaType)) {
          return { status: 400, errorType: "invalid_request_error", message: "Image does not match the provided media type" };
        }
      }
      if (block.type === "document" && isRecord(block.source) && block.source.type === "base64") {
        if (block.source.media_type !== "application/pdf") {
          return { status: 400, errorType: "invalid_request_error", message: "document media_type must be application/pdf" };
        }
        if (!strictBase64(typeof block.source.data === "string" ? block.source.data : "")) {
          return { status: 400, errorType: "invalid_request_error", message: "document base64 does not decode" };
        }
      }
    }
  }
  return null;
}

function strictBase64(data: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return null;
  return bytes;
}

function imageMagic(bytes: Buffer, mediaType: string): boolean {
  if (mediaType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === "image/png") return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (mediaType === "image/gif") return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mediaType === "image/webp") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

/**
 * Pairing still has to hold. A later file turn drops cart tools from the request,
 * so an earlier add_to_cart block is history, not an offer to call that tool again.
 */
function judgeToolHistory(body: Record<string, unknown>): MessagesVerdict | null {
  if (!Array.isArray(body.messages)) return null;
  const seen = new Set<string>();
  let pending = new Map<string, string>();
  for (const message of body.messages) {
    if (!isRecord(message)) continue;
    const blocks = contentBlocks(message.content);
    if (message.role === "assistant") {
      if (pending.size > 0) {
        return {
          status: 400,
          errorType: "invalid_request_error",
          message: "tool_use missing tool_result",
        };
      }
      pending = new Map();
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        if (typeof block.id !== "string" || typeof block.name !== "string") {
          return {
            status: 400,
            errorType: "invalid_request_error",
            message: "tool_use requires id and name",
          };
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(block.id) || block.id.startsWith("srvtoolu_")) {
          return {
            status: 400,
            errorType: "invalid_request_error",
            message: "tool_use id must match ^[a-zA-Z0-9_-]+$",
          };
        }
        if (seen.has(block.id)) {
          return {
            status: 400,
            errorType: "invalid_request_error",
            message: "duplicate tool_use id",
          };
        }
        seen.add(block.id);
        pending.set(block.id, block.name);
      }
    }
    if (message.role === "user") {
      let sawOther = false;
      for (const block of blocks) {
        if (block.type === "tool_result") {
          if (sawOther) {
            return {
              status: 400,
              errorType: "invalid_request_error",
              message: "tool_result blocks must come first",
            };
          }
        } else {
          sawOther = true;
        }
      }
      const results = blocks.filter((block) => block.type === "tool_result");
      if (results.length === 0) {
        if (pending.size > 0) {
          return {
            status: 400,
            errorType: "invalid_request_error",
            message: "tool_use missing tool_result",
          };
        }
        continue;
      }
      const answered = new Set<string>();
      for (const block of results) {
        const id = block.tool_use_id;
        if (typeof id !== "string" || !pending.has(id) || answered.has(id)) {
          return {
            status: 400,
            errorType: "invalid_request_error",
            message: "orphaned or duplicate tool_result",
          };
        }
        answered.add(id);
      }
      if (answered.size !== pending.size) {
        return {
          status: 400,
          errorType: "invalid_request_error",
          message: "tool_result set does not match tool_use",
        };
      }
      pending = new Map();
    }
  }
  if (pending.size > 0) {
    return {
      status: 400,
      errorType: "invalid_request_error",
      message: "tool_use missing tool_result",
    };
  }
  return null;
}

export function messagesSuccessBody(model: string, text = "ok") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function errorBody(verdict: MessagesVerdict) {
  return {
    type: "error",
    error: { type: verdict.errorType, message: verdict.message },
    request_id: "req_test",
  };
}

async function readBody(init: RequestInit | undefined, input: RequestInfo | URL): Promise<string> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return await new Response(raw as BodyInit).text();
}

export function createMessagesApiDouble(expectedKey: string): MessagesApiDouble {
  const requests: RecordedMessagesRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = {
      ...headerMap(input instanceof Request ? input.headers : undefined),
      ...headerMap(init?.headers),
    };
    const text = await readBody(init, input);
    let body: Record<string, unknown> | null = null;
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        body = isRecord(parsed) ? parsed : null;
      } catch {
        body = null;
      }
    }
    requests.push({ url, method, headers, body });
    const verdict = judgeMessagesRequest({ url, method, headers, body, expectedKey });
    if (verdict) {
      return Response.json(errorBody(verdict), { status: verdict.status });
    }
    return Response.json(messagesSuccessBody(String(body?.model ?? "")));
  };
  return { fetch: fetchImpl, requests };
}

export interface FakeAnthropicStep {
  kind: "text" | "tool" | "error";
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** Server-side web search blocks sent before the tool call (non-streaming only). */
  webSearch?: { query: string; results: Array<{ url: string; title: string }> };
  inputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
}

export interface FakeAnthropic {
  fetch: typeof fetch;
  requests: RecordedMessagesRequest[];
}

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function usageOf(step: FakeAnthropicStep) {
  return {
    input_tokens: step.inputTokens ?? 12,
    cache_creation_input_tokens: step.cacheWriteTokens ?? 0,
    cache_read_input_tokens: step.cacheReadTokens ?? 0,
    output_tokens: step.outputTokens ?? 4,
  };
}

function eventsFor(step: FakeAnthropicStep, model: string, toolId = "toolu_fake_0"): unknown[] {
  const usage = usageOf(step);
  const start = {
    type: "message_start",
    message: {
      id: "msg_fake",
      model,
      role: "assistant",
      usage: {
        input_tokens: usage.input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      },
    },
  };
  if (step.kind === "error") {
    return [
      start,
      { type: "ping" },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ];
  }
  if (step.kind === "tool") {
    const name = step.toolName ?? "ping";
    const input = JSON.stringify(step.toolInput ?? {});
    const preamble = step.text
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } },
          { type: "content_block_stop", index: 0 },
        ]
      : [];
    const toolIndex = step.text ? 1 : 0;
    return [
      start,
      { type: "ping" },
      ...preamble,
      {
        type: "content_block_start",
        index: toolIndex,
        content_block: { type: "tool_use", id: toolId, name },
      },
      { type: "content_block_delta", index: toolIndex, delta: { type: "input_json_delta", partial_json: input } },
      { type: "content_block_stop", index: toolIndex },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      },
      { type: "message_stop" },
    ];
  }
  return [
    start,
    { type: "ping" },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text ?? "ok" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    },
    { type: "message_stop" },
  ];
}

/** Real-adapter stand-in. SSE when the request asks to stream, JSON otherwise. */
export function createFakeAnthropicFetch(options?: {
  expectedKey?: string;
  steps?: FakeAnthropicStep[];
}): FakeAnthropic {
  const expectedKey = options?.expectedKey ?? "sk-ant-test";
  const steps = options?.steps ?? [{ kind: "text" as const, text: "ok" }];
  const requests: RecordedMessagesRequest[] = [];
  let cursor = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = {
      ...headerMap(input instanceof Request ? input.headers : undefined),
      ...headerMap(init?.headers),
    };
    const text = await readBody(init, input);
    let body: Record<string, unknown> | null = null;
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        body = isRecord(parsed) ? parsed : null;
      } catch {
        body = null;
      }
    }
    requests.push({ url, method, headers, body });
    const verdict = judgeMessagesRequest({ url, method, headers, body, expectedKey });
    if (verdict) {
      return Response.json(errorBody(verdict), { status: verdict.status });
    }
    const step = steps[Math.min(cursor, steps.length - 1)];
    const toolId = `toolu_fake_${cursor}`;
    cursor += 1;
    const model = String(body?.model ?? "");
    if (body?.stream === true) {
      return new Response(sse(eventsFor(step, model, toolId)), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (step.kind === "error") {
      return Response.json(
        {
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
          request_id: "req_fake_step",
        },
        { status: 529, headers: { "request-id": "req_fake_step" } },
      );
    }
    const usage = usageOf(step);
    if (step.kind === "tool") {
      const content: Array<Record<string, unknown>> = [];
      if (step.webSearch) {
        const declared = (Array.isArray(body?.tools) ? body.tools : []).some(
          (item) => isRecord(item) && item.name === "web_search",
        );
        if (!declared) {
          return Response.json(
            errorBody({ status: 400, errorType: "invalid_request_error", message: "web_search is not declared" }),
            { status: 400 },
          );
        }
        content.push(
          { type: "server_tool_use", id: "srvtoolu_fake_0", name: "web_search", input: { query: step.webSearch.query } },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_fake_0",
            content: step.webSearch.results.map((result) => ({
              type: "web_search_result",
              url: result.url,
              title: result.title,
              encrypted_content: "fake",
              page_age: null,
            })),
          },
        );
      }
      if (step.text) content.push({ type: "text", text: step.text });
      content.push({
        type: "tool_use",
        id: toolId,
        name: step.toolName ?? "ping",
        input: step.toolInput ?? {},
      });
      return Response.json({
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: step.webSearch ? { ...usage, server_tool_use: { web_search_requests: 1 } } : usage,
      });
    }
    return Response.json({
      ...messagesSuccessBody(model, step.text ?? "ok"),
      usage,
    });
  };
  return { fetch: fetchImpl, requests };
}
