import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { revalidateStorefront } from "@/lib/storefront/cache";
import { revalidateTag } from "next/cache";
import { parseInput } from "@/lib/security/parse-input";

const bodySchema = z.strictObject({
  stores: z.array(z.strictObject({
    id: z.string().min(1).max(100),
    slug: z.string().min(1).max(100),
  })).max(50),
});

/** Offline seeds cannot call Next's request-scoped revalidation API directly. */
export async function POST(request: Request) {
  const secret = process.env.STOREFRONT_REVALIDATION_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || Buffer.byteLength(secret) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) {
    return new Response(null, { status: 401 });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = null;
  }
  const body = parseInput(bodySchema, raw);
  if (!body.ok) return new Response(null, { status: 400 });
  for (const store of body.data.stores) {
    revalidateStorefront(store.id);
    revalidateTag(`store-slug:${store.slug}`, { expire: 0 });
    revalidateTag(`store:${store.id}`, { expire: 0 });
  }
  return Response.json({ revalidated: body.data.stores.length });
}
