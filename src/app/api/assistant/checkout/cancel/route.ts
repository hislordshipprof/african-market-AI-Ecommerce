import { z } from "zod";
import { customerCancelOrder } from "@/lib/order/service";
import { checkoutActor, checkoutJson, parseCheckout, readCheckoutBody } from "@/lib/assistant/checkout/http";

export const runtime = "nodejs";

const cancelSchema = z.object({
  orderId: z.string().trim().min(1).max(80),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const body = await readCheckoutBody(request);
  if (!body.ok) return checkoutJson({ ok: false, code: body.code, message: body.message }, body.status);
  const parsed = parseCheckout(cancelSchema, body.body);
  if (!parsed.ok) return checkoutJson({ ok: false, code: parsed.code, message: parsed.message }, parsed.status);
  const actor = await checkoutActor(request);
  if (!actor.ok) return checkoutJson({ ok: false, code: actor.code, message: actor.message }, actor.status);
  const result = await customerCancelOrder({
    storeId: actor.actor.storeId,
    orderId: parsed.data.orderId,
    cartId: actor.actor.cartId,
    actorUserId: actor.actor.actorUserId,
    actorEmail: actor.actor.actorEmail,
  });
  if (!result.ok && result.code === "not_found") return checkoutJson(result, 404);
  if (!result.ok && result.code === "window_closed") return checkoutJson(result, 409);
  if (!result.ok) return checkoutJson(result, 409);
  return checkoutJson(result, 200, actor.actor.headers);
}
