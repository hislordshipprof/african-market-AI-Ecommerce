import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientIp } from "@/lib/assistant/client-ip";
import { takeRateLimit } from "@/lib/rate-limit/app-limiter";
import { readBrowserId } from "@/lib/cart/browser";
import { parseInput } from "@/lib/security/parse-input";
import { parseNearQuery } from "@/lib/directory/near-query";
import { isUsPoint, locate, nearestStores, type Point } from "@/lib/directory/near";
import { storefrontUrl } from "@/lib/directory/links";

const NEAR_WINDOW_MS = 60_000;
export const NEAR_BROWSER_LIMIT = 20;
const NEAR_IP_LIMIT = 120;
const coordinate = (limit: number) => z.string().regex(/^-?\d{1,3}(\.\d{1,8})?$/).transform(Number).pipe(z.number().min(-limit).max(limit));
const coordinates = z.object({ lat: coordinate(90), lng: coordinate(180) });

const BAD_INPUT = "Enter a 5-digit ZIP code or a city.";

/** Store directory near me (#452): a ZIP, a city or a browser point in; the nearest listed stores out. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  let point: (Point & { label: string | null }) | null = null;
  let query: ReturnType<typeof parseNearQuery> = null;
  if (params.has("lat") || params.has("lng")) {
    const parsed = parseInput(coordinates, { lat: params.get("lat") ?? "", lng: params.get("lng") ?? "" });
    if (!parsed.ok) {
      return NextResponse.json({ error: BAD_INPUT }, { status: 400 });
    }
    point = { ...parsed.data, label: null };
  } else {
    query = parseNearQuery(params.get("q") ?? "");
    if (!query) return NextResponse.json({ error: BAD_INPUT }, { status: 400 });
  }

  const browser = readBrowserId(request.headers.get("x-shop-browser"), null);
  const [byBrowser, byIp] = await Promise.all([
    takeRateLimit(`directory-near:browser:${browser ?? "missing"}`, NEAR_BROWSER_LIMIT, NEAR_WINDOW_MS),
    takeRateLimit(`directory-near:ip:${clientIp(request.headers)}`, NEAR_IP_LIMIT, NEAR_WINDOW_MS),
  ]);
  const limited = !byBrowser.ok ? byBrowser : !byIp.ok ? byIp : null;
  if (limited) {
    return NextResponse.json(
      { error: "Too many searches. Try again in a minute." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } },
    );
  }

  if (query) {
    const located = await locate(query);
    if (located.kind !== "point") return NextResponse.json(located);
    point = located;
  } else if (point && !(await isUsPoint(point))) {
    return NextResponse.json({ kind: "outside" });
  }

  const { nearby, stores } = await nearestStores(point!);
  const host = request.headers.get("host") ?? "";
  return NextResponse.json({
    kind: "stores",
    label: point!.label,
    nearby,
    stores: stores.flatMap((store) => {
      const href = storefrontUrl(store.slug, host);
      return href ? [{ ...store, href }] : [];
    }),
  });
}
