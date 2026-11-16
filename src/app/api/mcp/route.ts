import { headers } from "next/headers";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { clientIp } from "@/lib/assistant/client-ip";
import { catalogServer } from "@/lib/catalog-mcp/server";
import { findStoreForHeaders } from "@/lib/get-store";
import { takeRateLimit } from "@/lib/rate-limit/app-limiter";

const CALLS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

/**
 * The store host's read-only catalog for AI agents (#572), streamable HTTP, no auth.
 * Not there (404) unless the host is an open store whose owner turned on "Let AI assistants read my catalog".
 */
async function handle(request: Request): Promise<Response> {
  const store = await findStoreForHeaders(await headers());
  if (!store || store.status !== "active" || !store.aiCatalogReadable) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const ip = clientIp(request.headers);
  const limit = await takeRateLimit(`mcp:ip:${ip}`, CALLS_PER_MINUTE, WINDOW_MS);
  if (!limit.ok) {
    return Response.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  }

  const origin = new URL(request.url).origin;
  const handler = createMcpHandler(() => catalogServer({ store, origin, ip }), { responseMode: "json" });
  return handler.fetch(request);
}

export { handle as GET, handle as POST, handle as DELETE };
