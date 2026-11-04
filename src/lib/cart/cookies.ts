import { cookies } from "next/headers";

export const CART_COOKIE = "cart_id";
export const CART_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

export async function getCartIdFromCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(CART_COOKIE)?.value ?? null;
}

export async function setCartIdCookie(cartId: string): Promise<void> {
  const jar = await cookies();
  jar.set(CART_COOKIE, cartId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: CART_COOKIE_MAX_AGE,
    path: "/",
  });
}

/** Same attributes as setCartIdCookie, for a response that is already streaming. */
export function serializeCartCookie(id: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${CART_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${CART_COOKIE_MAX_AGE}${secure}`;
}
