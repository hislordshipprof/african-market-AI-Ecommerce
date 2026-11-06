import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/get-store";
import { searchListings } from "@/lib/storefront/service";
import { clientIp } from "@/lib/assistant/client-ip";
import { takeRateLimit } from "@/lib/rate-limit/app-limiter";
import { parseInput } from "@/lib/security/parse-input";
import { SEARCH_QUERY_TOO_LONG, normalizedSearchQuery } from "@/lib/storefront/search-query";

const SEARCH_WINDOW_MS = 60_000;
const BROWSER_LIMIT = 60;
const IP_LIMIT = 300;
const browserId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);

export async function GET(request: NextRequest) {
  const rawQuery = request.nextUrl.searchParams.get("q") ?? "";
  const query = parseInput(z.string().max(10_000), rawQuery);
  if (!query.ok) {
    return NextResponse.json({ error: SEARCH_QUERY_TOO_LONG }, { status: 400 });
  }
  const { query: trimmed, tooLong } = normalizedSearchQuery(query.data);
  if (tooLong) {
    return NextResponse.json({ error: SEARCH_QUERY_TOO_LONG }, { status: 400 });
  }

  const store = await getStore();
  if (store.status === "suspended") {
    return NextResponse.json({ error: "Store unavailable" }, { status: 404 });
  }
  if (!trimmed) return NextResponse.json({ results: [] });

  const browser = parseInput(browserId, request.headers.get("x-shop-browser") ?? "");
  const browserKey = browser.ok ? browser.data : "missing";
  const ip = clientIp(request.headers);
  const [byBrowser, byIp] = await Promise.all([
    takeRateLimit(`search:browser:${browserKey}`, BROWSER_LIMIT, SEARCH_WINDOW_MS),
    takeRateLimit(`search:ip:${ip}`, IP_LIMIT, SEARCH_WINDOW_MS),
  ]);
  const limited = !byBrowser.ok ? byBrowser : !byIp.ok ? byIp : null;
  if (limited) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } },
    );
  }

  const results = await searchListings(store.id, trimmed);
  return NextResponse.json({ results });
}
