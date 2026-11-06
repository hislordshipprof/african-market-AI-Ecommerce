import { z } from "zod";
import { getStore } from "@/lib/get-store";
import { getListingDetail } from "@/lib/storefront/service";
import { isListingId } from "@/lib/security/listing-id";
import { parseInput } from "@/lib/security/parse-input";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = parseInput(z.string().max(200), id);
  if (!parsed.ok || !isListingId(parsed.data)) {
    return Response.json({ error: "Listing not found" }, { status: 404 });
  }
  const store = await getStore();
  if (store.status === "suspended") return Response.json({ error: "Store unavailable" }, { status: 404 });
  const listing = await getListingDetail(store.id, parsed.data);
  return listing ? Response.json(listing) : Response.json({ error: "Listing not found" }, { status: 404 });
}
