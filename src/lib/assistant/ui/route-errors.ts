import { ASSISTANT_FIXED_ERROR, ASSISTANT_ROUTE_CODES, type AssistantRouteCode } from "../contract";

export class AssistantRouteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: string | null;
  readonly parsed: boolean;

  constructor(input: { code?: string; status: number; retryAfter?: string | null; parsed: boolean }) {
    super(ASSISTANT_FIXED_ERROR);
    this.name = "AssistantRouteError";
    this.code = input.code ?? "unknown";
    this.status = input.status;
    this.retryAfter = input.retryAfter ?? null;
    this.parsed = input.parsed;
  }
}

export type RouteView = {
  code: string;
  title: string;
  searchHref: "/search";
  terminal: boolean;
  retry: boolean;
};

const KNOWN = new Set<string>(ASSISTANT_ROUTE_CODES);

export function minutesFromRetryAfter(header: string | null | undefined, nowMs = Date.now()): number | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.max(1, Math.ceil(Math.min(seconds, 86_400) / 60));
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  const seconds = (when - nowMs) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1, Math.ceil(Math.min(seconds, 86_400) / 60));
}

export function mapRouteError(input: {
  code?: string | null;
  retryAfter?: string | null;
  network?: boolean;
  parsed?: boolean;
}): RouteView {
  const code = input.network || input.parsed === false ? "unknown" : (input.code ?? "unknown");
  const known = KNOWN.has(code) ? (code as AssistantRouteCode) : null;
  if (known === "rate_limited") {
    const minutes = minutesFromRetryAfter(input.retryAfter);
    const title = minutes == null
      ? "Too many messages. Try again in a little while."
      : `Too many messages. Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
    return { code, title, searchHref: "/search", terminal: false, retry: false };
  }
  if (known === "assistant_resting") {
    return {
      code,
      title: "The helper is resting right now. You can keep shopping the usual way.",
      searchHref: "/search",
      terminal: true,
      retry: false,
    };
  }
  if (known === "assistant_unavailable" || known === "assistant_disabled") {
    return {
      code,
      title: "The helper isn't available right now.",
      searchHref: "/search",
      terminal: true,
      retry: false,
    };
  }
  if (known === "store_suspended") {
    return {
      code,
      title: "This store isn't taking orders right now.",
      searchHref: "/search",
      terminal: true,
      retry: false,
    };
  }
  if (known === "assistant_busy") {
    return {
      code,
      title: "Still working on your last message.",
      searchHref: "/search",
      terminal: false,
      retry: true,
    };
  }
  if (known === "invalid_request") {
    return {
      code,
      title: "Couldn't send that.",
      searchHref: "/search",
      terminal: false,
      retry: true,
    };
  }
  return {
    code: known ?? "unknown",
    title: ASSISTANT_FIXED_ERROR,
    searchHref: "/search",
    terminal: false,
    retry: true,
  };
}

export function createAssistantFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new AssistantRouteError({ status: 0, parsed: false });
    }
    if (response.ok) return response;
    const retryAfter = response.headers.get("retry-after");
    const text = await response.text();
    let code: string | undefined;
    let parsed = false;
    try {
      const json: unknown = JSON.parse(text);
      const record = json && typeof json === "object" ? json as { error?: { code?: unknown } } : null;
      if (typeof record?.error?.code === "string") {
        code = record.error.code;
        parsed = true;
      }
    } catch {
      parsed = false;
    }
    throw new AssistantRouteError({ code, status: response.status, retryAfter, parsed });
  };
}

function isAbort(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && (error as { name: string }).name === "AbortError";
}
