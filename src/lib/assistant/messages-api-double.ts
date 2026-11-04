export type RecordedMessagesRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};

export type MessagesApiDouble = {
  fetch: typeof fetch;
  calls: RecordedMessagesRequest[];
};

const KNOWN_MODELS = new Set(["claude-haiku-5-5", "claude-sonnet-5-5"]);
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export function createMessagesApiDouble(expectedKey: string): MessagesApiDouble {
  const calls: RecordedMessagesRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const recorded = await recordRequest(input, init);
    calls.push(recorded);
    const status = rejectionStatus(recorded, expectedKey);
    if (status === 401) {
      return jsonResponse(401, {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
        request_id: "req_fixture",
      });
    }
    if (status === 400) {
      return jsonResponse(400, {
        type: "error",
        error: { type: "invalid_request_error", message: "rejected by the Messages API contract" },
        request_id: "req_fixture",
      });
    }
    const model = typeof recorded.body?.model === "string" ? recorded.body.model : "";
    return jsonResponse(200, {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, calls };
}

async function recordRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<RecordedMessagesRequest> {
  const request = input instanceof Request ? input : null;
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(request?.headers);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const recordedHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    recordedHeaders[key.toLowerCase()] = value;
  });
  const rawBody = await bodyText(init?.body ?? (request ? await request.clone().text() : ""));
  let body: Record<string, unknown> | null = null;
  if (rawBody) {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      body = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
  }
  return { url, method, headers: recordedHeaders, body };
}

function rejectionStatus(request: RecordedMessagesRequest, expectedKey: string): 400 | 401 | null {
  if (!requestShapeAccepted(request)) return 400;
  const presented = request.headers["x-api-key"];
  if (presented === undefined || presented !== expectedKey) return 401;
  if (requestRejectedByModelContract(request)) return 400;
  return null;
}

function requestShapeAccepted(request: RecordedMessagesRequest): boolean {
  if (request.method !== "POST" || request.url !== MESSAGES_URL) return false;
  if (request.headers["anthropic-version"] !== API_VERSION) return false;
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) return false;
  const body = request.body;
  if (!body) return false;
  if (typeof body.model !== "string" || !KNOWN_MODELS.has(body.model)) return false;
  if (typeof body.max_tokens !== "number") return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  return body.messages.every((message) => {
    if (message === null || typeof message !== "object") return false;
    const record = message as Record<string, unknown>;
    return typeof record.role === "string" && "content" in record;
  });
}

function requestRejectedByModelContract(request: RecordedMessagesRequest): boolean {
  const body = request.body;
  if (!body || typeof body.model !== "string") return true;
  if ("temperature" in body || "top_p" in body || "top_k" in body) return true;
  return thinkingRejected(body.model, thinkingType(body), effortOf(body));
}

function thinkingType(body: Record<string, unknown>): string | undefined {
  if (!("thinking" in body) || body.thinking == null) return undefined;
  if (typeof body.thinking !== "object") return "invalid";
  const type = (body.thinking as { type?: unknown }).type;
  return typeof type === "string" ? type : "invalid";
}

function effortOf(body: Record<string, unknown>): string | undefined {
  const output = body.output_config;
  if (output === null || typeof output !== "object") return undefined;
  const effort = (output as { effort?: unknown }).effort;
  return typeof effort === "string" ? effort : undefined;
}

function thinkingRejected(model: string, type: string | undefined, effort: string | undefined): boolean {
  if (type === undefined || type === "adaptive") return false;
  const aboveHigh = effort === "xhigh" || effort === "max";
  if (model === "claude-haiku-5-5") {
    if (type === "disabled") return aboveHigh;
    return true;
  }
  if (model === "claude-sonnet-5-5") {
    if (type === "between_tools") return aboveHigh;
    return true;
  }
  return true;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function bodyText(body: BodyInit | null | undefined | string): Promise<string> {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return "";
}
