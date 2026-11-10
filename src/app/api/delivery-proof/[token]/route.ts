import { z } from "zod";
import { getStore } from "@/lib/get-store";
import { findOrderByTrackingToken } from "@/lib/notifications/lookup";
import { streamDeliveryProof } from "@/lib/r2";
import { parseInput } from "@/lib/security/parse-input";

const tokenSchema = z.string().min(1).max(200);

function notFound() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
}

/** The proof photo is private: only the tracking token opens it, never the order id. */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const parsed = parseInput(tokenSchema, token);
  if (!parsed.ok) return notFound();
  const store = await getStore();
  const order = await findOrderByTrackingToken(store.id, parsed.data).catch(() => null);
  if (!order?.deliveryProofKey) return notFound();
  const photo = await streamDeliveryProof(order.deliveryProofKey);
  if (!photo) return notFound();
  return new Response(photo.body, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
