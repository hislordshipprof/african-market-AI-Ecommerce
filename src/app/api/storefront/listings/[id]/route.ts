import { getStore } from "@/lib/get-store";
import { getListingDetail } from "@/lib/storefront/service";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const [store, { id }] = await Promise.all([getStore(), context.params]);
  if (store.status === "suspended") return Response.json({ error: "Store unavailable" }, { status: 404 });
  const listing = await getListingDetail(store.id, id);
  return listing ? Response.json(listing) : Response.json({ error: "Listing not found" }, { status: 404 });
}
