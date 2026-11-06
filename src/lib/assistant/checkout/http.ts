import { z } from "zod";
import { CART_COOKIE, serializeCartCookie } from "../../cart/cookies";
import { readBrowserId } from "../../cart/browser";
import { CartError, getOrCreateCart } from "../../cart/service";
import { storeScoped } from "../../db";
import { findStore } from "../../get-store";
import { auth } from "../../auth";
import { requireSameOrigin } from "../../security/same-origin";
import { takeRateLimit } from "../../rate-limit/app-limiter";

const BODY_CAP = 4096;
const PAYMENT_LIMIT = 30;
const PAYMENT_WINDOW_MS = 60 * 60 * 1000;

export interface CheckoutActor {
  storeId: string;
  cartId: string;
  actorUserId: string | null;
  actorEmail: string;
  conversationId: string | null;
  headers: Headers;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function readCheckoutBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; status: number; code: string; message: string }> {
  if (!requireSameOrigin(request)) {
    return { ok: false, status: 403, code: "forbidden_origin", message: "This request was not sent from the store." };
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > BODY_CAP) {
    return { ok: false, status: 413, code: "invalid_request", message: "That request is too large." };
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > BODY_CAP) {
    return { ok: false, status: 413, code: "invalid_request", message: "That request is too large." };
  }
  if (bytes.byteLength === 0) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400, code: "invalid_request", message: "That request could not be read." };
  }
}

export function parseCheckout<T>(schema: z.ZodType<T>, body: unknown): { ok: true; data: T } | { ok: false; status: 400; code: "invalid_request"; message: string } {
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, code: "invalid_request", message: "That request could not be read." };
  return { ok: true, data: parsed.data };
}

export async function checkoutActor(request: Request): Promise<{ ok: true; actor: CheckoutActor } | { ok: false; status: number; code: string; message: string }> {
  const slug = request.headers.get("x-store-slug");
  const store = slug ? await findStore(slug) : null;
  if (!store) return { ok: false, status: 404, code: "not_found", message: "That checkout is not available." };
  if (store.status === "suspended") return { ok: false, status: 403, code: "store_suspended", message: "This store is not taking orders." };
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  const actorUserId = session?.user?.id ?? null;
  const cookieCart = readCookie(request.headers.get("cookie"), CART_COOKIE);
  let cartId: string;
  try {
    cartId = await getOrCreateCart(
      store.id,
      cookieCart,
      actorUserId,
      readBrowserId(request.headers.get("x-shop-browser"), request.headers.get("cookie")),
    );
  } catch (error) {
    if (error instanceof CartError) return { ok: false, status: 404, code: "not_found", message: "That checkout is not available." };
    throw error;
  }
  const conversation = await storeScoped(store.id).aiConversation.findUnique({
    where: { storeId_cartId: { storeId: store.id, cartId } },
    select: { id: true },
  });
  const headers = new Headers();
  if (cookieCart !== cartId) headers.append("set-cookie", serializeCartCookie(cartId));
  return {
    ok: true,
    actor: {
      storeId: store.id,
      cartId,
      actorUserId,
      actorEmail: session?.user?.email ?? "guest@checkout",
      conversationId: conversation?.id ?? null,
      headers,
    },
  };
}

export async function limitNewPayment(cartId: string): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  return takeRateLimit(`payment:${cartId}`, PAYMENT_LIMIT, PAYMENT_WINDOW_MS);
}

export function checkoutJson(body: unknown, status: number, headers?: Headers): Response {
  const response = Response.json(body, { status });
  headers?.forEach((value, key) => response.headers.append(key, value));
  return response;
}
