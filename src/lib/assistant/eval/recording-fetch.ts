import type { TokenUsage } from "../cost";

export interface RecordedToolUse {
  name: string;
  input: unknown;
}

export interface RecordedExchange {
  status: number;
  requestId: string | null;
  retryAfter: string | null;
  errorType: string | null;
  sseError: boolean;
  usage: TokenUsage | null;
  unresolvedUsage: boolean;
  text: string;
  toolUses: RecordedToolUse[];
  requestBody: Record<string, unknown> | null;
  done: Promise<void>;
}

export function recordingFetch(inner: typeof fetch, sink: RecordedExchange[]): typeof fetch {
  return async (input, init) => {
    const requestBody = await readRequestBody(input, init);
    const response = await inner(input, init);
    const status = response.status;
    const requestId = response.headers.get("request-id");
    const retryAfter = response.headers.get("retry-after");
    const contentType = response.headers.get("content-type") ?? "";
    const exchange: RecordedExchange = {
      status,
      requestId,
      retryAfter,
      errorType: null,
      sseError: false,
      usage: null,
      unresolvedUsage: true,
      text: "",
      toolUses: [],
      requestBody,
      done: Promise.resolve(),
    };
    if (!response.ok || !response.body) {
      const text = await response.clone().text().catch(() => "");
      const parsed = parseJson(text);
      exchange.errorType = errorTypeOf(parsed);
      exchange.usage = usageFromJson(parsed);
      exchange.unresolvedUsage = response.ok && exchange.usage == null;
      exchange.done = Promise.resolve();
      sink.push(exchange);
      return response;
    }
    if (!contentType.includes("text/event-stream")) {
      const text = await response.clone().text().catch(() => "");
      const parsed = parseJson(text);
      exchange.usage = usageFromJson(parsed);
      exchange.unresolvedUsage = response.ok && exchange.usage == null;
      exchange.text = typeof parsed === "object" && parsed && "content" in (parsed as object) ? "" : text;
      sink.push(exchange);
      return response;
    }
    const [watch, pass] = response.body.tee();
    exchange.done = readSse(watch).then((parsed) => {
      exchange.usage = parsed.usage;
      exchange.unresolvedUsage = parsed.unresolvedUsage;
      exchange.sseError = parsed.sseError;
      exchange.text = parsed.text;
      exchange.toolUses = parsed.toolUses;
      if (parsed.sseError) exchange.errorType = "sse_error";
    });
    sink.push(exchange);
    return new Response(pass, { status: response.status, headers: response.headers });
  };
}

async function readRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown> | null> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  if (typeof raw !== "string" || raw === "") return null;
  const parsed = parseJson(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorTypeOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const error = (value as { error?: { type?: unknown } }).error;
  return typeof error?.type === "string" ? error.type : null;
}

function usageFromJson(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = (value as { usage?: Record<string, unknown> }).usage;
  if (!usage) return null;
  const input = numberOrZero(usage.input_tokens);
  const cacheWrite = numberOrZero(usage.cache_creation_input_tokens);
  const cacheRead = numberOrZero(usage.cache_read_input_tokens);
  const output = numberOrZero(usage.output_tokens);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  return {
    inputTokens: {
      total: input,
      noCache: Math.max(0, input - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
    },
    outputTokens: { total: output },
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function readSse(stream: ReadableStream<Uint8Array>): Promise<{
  usage: TokenUsage | null;
  unresolvedUsage: boolean;
  sseError: boolean;
  text: string;
  toolUses: RecordedToolUse[];
}> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawStart = false;
  let sawDelta = false;
  let sseError = false;
  let inputTokens = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let outputTokens = 0;
  let text = "";
  const toolUses: RecordedToolUse[] = [];
  let current = -1;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((item) => item.startsWith("data:"));
      if (!line || line.includes("[DONE]")) continue;
      const json = parseJson(line.slice(5).trim());
      if (!json || typeof json !== "object") continue;
      const event = json as {
        type?: string;
        message?: { usage?: Record<string, unknown> };
        content_block?: { type?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
        usage?: { output_tokens?: unknown };
        error?: unknown;
      };
      if (event.type === "message_start") {
        sawStart = true;
        const usage = event.message?.usage ?? {};
        inputTokens = numberOrZero(usage.input_tokens);
        cacheWrite = numberOrZero(usage.cache_creation_input_tokens);
        cacheRead = numberOrZero(usage.cache_read_input_tokens);
      } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        current = toolUses.length;
        toolUses.push({ name: event.content_block.name ?? "", input: {} });
      } else if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta") text += event.delta.text ?? "";
        if (event.delta?.type === "input_json_delta" && current >= 0) {
          const tool = toolUses[current];
          if (tool) {
            const previous = typeof tool.input === "string" ? tool.input : "";
            tool.input = previous + (event.delta.partial_json ?? "");
          }
        }
      } else if (event.type === "message_delta") {
        sawDelta = true;
        if (typeof event.usage?.output_tokens === "number") outputTokens = event.usage.output_tokens;
      } else if (event.type === "error") {
        sseError = true;
      }
    }
  }
  for (const tool of toolUses) {
    if (typeof tool.input === "string") tool.input = parseJson(tool.input) ?? { raw: tool.input };
  }
  const usage = sawStart
    ? {
        inputTokens: {
          total: inputTokens,
          noCache: Math.max(0, inputTokens - cacheRead - cacheWrite),
          cacheRead,
          cacheWrite,
        },
        outputTokens: { total: outputTokens },
      }
    : null;
  return {
    usage,
    unresolvedUsage: !sawDelta,
    sseError,
    text,
    toolUses,
  };
}
