import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/get-store";
import { searchListings } from "@/lib/storefront/service";

export async function GET(request: NextRequest) {
  const store = await getStore();
  const query = request.nextUrl.searchParams.get("q") ?? "";

  if (!query.trim()) {
    return NextResponse.json({ results: [] });
  }

  const results = await searchListings(store.id, query);
  return NextResponse.json({ results });
}
