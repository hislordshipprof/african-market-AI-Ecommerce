import { z } from "zod";
import { assistantChatEnabled } from "@/lib/assistant/contract";
import { saveGuestContact } from "@/lib/assistant/checkout/prepare";
import { checkoutActor, checkoutJson, parseCheckout, readCheckoutBody } from "@/lib/assistant/checkout/http";
import { validPhone } from "@/lib/customer-account/phone";

export const runtime = "nodejs";

const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().max(40).refine((value) => validPhone(value), "Enter a phone number."),
}).strict();

export async function POST(request: Request): Promise<Response> {
  if (!assistantChatEnabled()) {
    return checkoutJson({ ok: false, code: "not_found", message: "The helper is not available." }, 404);
  }
  const body = await readCheckoutBody(request);
  if (!body.ok) return checkoutJson({ ok: false, code: body.code, message: body.message }, body.status);
  const parsed = parseCheckout(contactSchema, body.body);
  if (!parsed.ok) return checkoutJson({ ok: false, code: parsed.code, message: parsed.message }, parsed.status);
  const actor = await checkoutActor(request);
  if (!actor.ok) return checkoutJson({ ok: false, code: actor.code, message: actor.message }, actor.status);
  if (!actor.actor.conversationId) {
    return checkoutJson({ ok: false, code: "not_found", message: "That checkout is not available." }, 404);
  }
  const saved = await saveGuestContact(
    { storeId: actor.actor.storeId, cartId: actor.actor.cartId, conversationId: actor.actor.conversationId, actorUserId: actor.actor.actorUserId },
    parsed.data,
  );
  if (!saved.ok) return checkoutJson({ ok: false, code: "not_found", message: "That checkout is not available." }, 404);
  return checkoutJson({ ok: true, contactOnFile: true }, 200, actor.actor.headers);
}
