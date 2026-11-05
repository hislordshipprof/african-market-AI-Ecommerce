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
  return judgeToolHistory(body);
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

/** Anthropic rejects orphaned, mismatched, duplicate, or undeclared tool calls. */
function judgeToolHistory(body: Record<string, unknown>): MessagesVerdict | null {
  if (!Array.isArray(body.messages)) return null;
  const declared = new Set<string>();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (isRecord(tool) && typeof tool.name === "string") declared.add(tool.name);
    }
  }
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
        if (seen.has(block.id)) {
          return {
            status: 400,
            errorType: "invalid_request_error",
            message: "duplicate tool_use id",
          };
        }
        if (declared.size > 0 && !declared.has(block.name)) {
          return {
            status: 400,
            errorType: "invalid_request_error",
            message: "undeclared tool",
          };
        }
        seen.add(block.id);
        pending.set(block.id, block.name);
      }
    }
    if (message.role === "user") {
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
    return [
      start,
      { type: "ping" },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolId, name },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input } },
      { type: "content_block_stop", index: 0 },
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
    const usage = usageOf(step);
    return Response.json({
      ...messagesSuccessBody(model, step.text ?? "ok"),
      usage,
    });
  };
  return { fetch: fetchImpl, requests };
}
