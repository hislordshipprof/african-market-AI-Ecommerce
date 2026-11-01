import { timingSafeEqual } from "node:crypto";
import { revalidateStorefront } from "@/lib/storefront/cache";
import { revalidateTag } from "next/cache";
/** Offline seeds cannot call Next's request-scoped revalidation API directly. */
export async function POST(request: Request) {
  const secret = process.env.STOREFRONT_REVALIDATION_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || Buffer.byteLength(secret) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) return new Response(null, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.stores) || body.stores.length > 50 || body.stores.some((s: { id?: unknown; slug?: unknown }) => !s || typeof s.id !== "string" || typeof s.slug !== "string" || s.id.length > 100 || s.slug.length > 100)) return new Response(null, { status: 400 });
  for (const store of body.stores) {
    revalidateStorefront(store.id);
    revalidateTag(`store-slug:${store.slug}`, { expire: 0 });
    revalidateTag(`store:${store.id}`, { expire: 0 });
  }
  return Response.json({ revalidated: body.stores.length });
}
