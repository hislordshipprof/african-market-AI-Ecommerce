import { cookies } from "next/headers";

const CART_COOKIE = "cart_id";
const MAX_AGE = 30 * 24 * 60 * 60; // 30 days

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
    maxAge: MAX_AGE,
    path: "/",
  });
}
