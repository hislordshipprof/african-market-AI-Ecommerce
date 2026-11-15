import { cookies, headers } from "next/headers";

export const CART_COOKIE = "cart_id";
export const CART_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

/**
 * The one decision for the cart cookie's `Secure` attribute (#321). Both writers use it.
 * 1. On Vercel (`VERCEL` truthy) always Secure: a client-sent `x-forwarded-proto` must not downgrade it.
 * 2. Otherwise follow the first `x-forwarded-proto` value (`next start` always fills it in), so a plain
 *    HTTP host keeps its cart: browsers drop Secure cookies set over http: on non-localhost hosts.
 * 3. With no protocol information, Secure exactly in production.
 */
export function cartCookieSecure(requestHeaders: Headers, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL) return true;
  const proto = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  return env.NODE_ENV === "production";
}

export async function getCartIdFromCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(CART_COOKIE)?.value ?? null;
}

export async function setCartIdCookie(cartId: string): Promise<void> {
  const secure = cartCookieSecure(await headers());
  const jar = await cookies();
  jar.set(CART_COOKIE, cartId, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: CART_COOKIE_MAX_AGE,
    path: "/",
  });
}

/** Same attributes as setCartIdCookie for the same request, for a response that is already streaming. */
export function serializeCartCookie(id: string, requestHeaders: Headers): string {
  const secure = cartCookieSecure(requestHeaders) ? "; Secure" : "";
  return `${CART_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${CART_COOKIE_MAX_AGE}${secure}`;
}
