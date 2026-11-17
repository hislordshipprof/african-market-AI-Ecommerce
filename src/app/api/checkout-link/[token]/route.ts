import type { NextRequest } from "next/server";
import { z } from "zod";
import { CART_COOKIE, serializeCartCookie } from "@/lib/cart/cookies";
import { findStoreForHeaders } from "@/lib/get-store";
import { parseInput } from "@/lib/security/parse-input";
import { redeemCheckoutLink } from "@/lib/cart/checkout-link";

export const dynamic = "force-dynamic";

const paramsSchema = z.strictObject({ token: z.string().min(1).max(64) });

function seeOther(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/**
 * A checkout link from the WhatsApp shopper (#559) or an AI agent over MCP (#573):
 * opens this store's normal checkout with the cart they filled, by setting the cart cookie. The order is placed only
 * on that page. A used, expired or unknown link, or one opened on another
 * store's host, goes to the expired page.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const store = await findStoreForHeaders(request.headers);
  if (!store) return seeOther("/");
  const parsed = parseInput(paramsSchema, await params);
  if (!parsed.ok) return seeOther("/checkout/link-expired");
  const result = await redeemCheckoutLink(store.id, parsed.data.token, request.cookies.get(CART_COOKIE)?.value ?? null, new Date());
  if (!result.ok) return seeOther("/checkout/link-expired");
  return seeOther("/checkout", serializeCartCookie(result.cartId, request.headers));
}
