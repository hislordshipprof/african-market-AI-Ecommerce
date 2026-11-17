import { headers } from "next/headers";
import { createMcpHandler, readRequestBody } from "@modelcontextprotocol/server";
import { clientIp } from "@/lib/assistant/client-ip";
import { catalogServer } from "@/lib/catalog-mcp/server";
import { findStoreForHeaders } from "@/lib/get-store";
import { takeRateLimit } from "@/lib/rate-limit/app-limiter";

const CALLS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
// Tool inputs are a search phrase, an id or a street address.
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The host the agent called, which the proxy resolved the store from. `request.url` is not it:
 * `next start` builds that from its own listen address.
 */
function hostOrigin(request: Request): string | null {
  const host = request.headers.get("host");
  if (!host) return null;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return `${proto === "https" ? "https" : "http"}://${host}`;
}

/** A JSON-RPC batch would run up to 100 tool calls on one rate-limit token, and agents do not need it. */
async function isBatch(request: Request): Promise<boolean> {
  const body = await readRequestBody(request.clone(), MAX_BODY_BYTES);
  if (body.tooLarge) return false;
  try {
    return Array.isArray(JSON.parse(body.text));
  } catch {
    return false;
  }
}

/**
 * The store host's read-only catalog for AI agents (#572), streamable HTTP, no auth.
 * Not there (404) unless the host is an open store whose owner turned on "Let AI assistants read my catalog".
 */
async function handle(request: Request): Promise<Response> {
  const store = await findStoreForHeaders(await headers());
  if (!store || store.status !== "active" || !store.aiCatalogReadable) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const origin = hostOrigin(request);
  if (!origin) return Response.json({ error: "Not found" }, { status: 404 });

  const ip = clientIp(request.headers);
  const limit = await takeRateLimit(`mcp:ip:${ip}`, CALLS_PER_MINUTE, WINDOW_MS);
  if (!limit.ok) {
    return Response.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  }

  if (await isBatch(request)) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: send one message per request" } }, { status: 400 });
  }

  const handler = createMcpHandler(() => catalogServer({ store, origin, ip }), { responseMode: "json", maxRequestBodySize: MAX_BODY_BYTES });
  return handler.fetch(request);
}

// POST only: the endpoint is stateless, so there is no session stream (GET) or session to end (DELETE).
export const POST = handle;
