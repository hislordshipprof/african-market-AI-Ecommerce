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
  /** The case turn, set by the runner once the turn ends. */
  turn?: number;
}

export function recordingFetch(inner: typeof fetch, sink: RecordedExchange[]): typeof fetch {
  return async (input, init) => {
    const requestBody = await readRequestBody(input, init);
    const exchange: RecordedExchange = {
      status: 0,
      requestId: null,
      retryAfter: null,
      errorType: null,
      sseError: false,
      usage: null,
      unresolvedUsage: true,
      text: "",
      toolUses: [],
      requestBody,
      done: Promise.resolve(),
    };
    sink.push(exchange);
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (error) {
      exchange.errorType = "transport";
      exchange.unresolvedUsage = true;
      throw error;
    }
    const status = response.status;
    const requestId = response.headers.get("request-id");
    const retryAfter = response.headers.get("retry-after");
    const contentType = response.headers.get("content-type") ?? "";
    exchange.status = status;
    exchange.requestId = requestId;
    exchange.retryAfter = retryAfter;
    if (!response.ok || !response.body) {
      const text = await response.clone().text().catch(() => "");
      const parsed = parseJson(text);
      exchange.errorType = errorTypeOf(parsed);
      exchange.usage = usageFromJson(parsed);
      exchange.unresolvedUsage = response.ok && exchange.usage == null;
      exchange.done = Promise.resolve();
      return response;
    }
    if (!contentType.includes("text/event-stream")) {
      const text = await response.clone().text().catch(() => "");
      const parsed = parseJson(text);
      exchange.usage = usageFromJson(parsed);
      exchange.unresolvedUsage = response.ok && exchange.usage == null;
      exchange.text = typeof parsed === "object" && parsed && "content" in (parsed as object) ? "" : text;
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
    }).catch(() => {
      exchange.unresolvedUsage = true;
      exchange.errorType = exchange.errorType ?? "transport";
    });
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

/** Anthropic's input_tokens already excludes cache reads and writes. https://platform.claude.com/docs/en/build-with-claude/prompt-caching */
export function anthropicUsage(input: number, cacheRead: number, cacheWrite: number, output: number): TokenUsage | null {
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  return {
    inputTokens: {
      noCache: input,
      cacheRead,
      cacheWrite,
      total: input + cacheRead + cacheWrite,
    },
    outputTokens: { total: output },
  };
}

function usageFromJson(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = (value as { usage?: Record<string, unknown> }).usage;
  if (!usage) return null;
  const input = numberOrZero(usage.input_tokens);
  const cacheWrite = numberOrZero(usage.cache_creation_input_tokens);
  const cacheRead = numberOrZero(usage.cache_read_input_tokens);
  const output = numberOrZero(usage.output_tokens);
  return anthropicUsage(input, cacheRead, cacheWrite, output);
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
  try {
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
  } catch {
    sseError = true;
  }
  for (const tool of toolUses) {
    if (typeof tool.input === "string") tool.input = parseJson(tool.input) ?? { raw: tool.input };
  }
  const usage = sawStart ? anthropicUsage(inputTokens, cacheRead, cacheWrite, outputTokens) : null;
  return {
    usage,
    unresolvedUsage: !sawDelta,
    sseError,
    text,
    toolUses,
  };
}
