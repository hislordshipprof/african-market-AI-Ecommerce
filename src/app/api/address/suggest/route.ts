import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/get-store";
import { clientIp } from "@/lib/assistant/client-ip";
import { suggestDeliveryAddresses } from "@/lib/address/confirm";
import { parseInput } from "@/lib/security/parse-input";

/** Suggestions are a route because Next.js runs server actions one at a time. */
export async function GET(request: NextRequest) {
  const parsed = parseInput(z.string().max(200), request.nextUrl.searchParams.get("q") ?? "");
  if (!parsed.ok || parsed.data.trim().length < 3) return NextResponse.json({ suggestions: [] });
  const query = parsed.data;
  const store = await getStore();
  if (store.lat == null || store.lng == null || !store.storeDeliveryEnabled) {
    return NextResponse.json({ suggestions: [] });
  }
  const suggestions = await suggestDeliveryAddresses(
    query,
    { lat: store.lat, lng: store.lng, radiusMi: Number(store.deliveryRadiusMi) },
    clientIp(request.headers),
  );
  return NextResponse.json({ suggestions });
}
