"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "../auth";

export type SignInLinkState =
  | { status: "idle"; email: string }
  | { status: "sent"; email: string }
  | { status: "error"; email: string; message: string };

const FORWARDED = ["cookie", "host", "origin", "user-agent", "x-forwarded-for", "x-real-ip", "x-store-slug"];

/**
 * The storefront sign-in form posts here, so it works before hydration and without JS.
 * It goes through the auth route's handler (not auth.api), so the per-IP rate limit, the
 * staff check and the per-inbox cap all still apply.
 */
export async function sendSignInLinkAction(
  _previous: SignInLinkState,
  form: FormData,
): Promise<SignInLinkState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!z.email().max(254).safeParse(email).success) {
    return { status: "error", email, message: "Enter a valid email address." };
  }
  const incoming = await headers();
  const host = incoming.get("host");
  if (!incoming.get("x-store-slug") || !host) {
    return { status: "error", email, message: "Sign-in is only available on a store's site." };
  }
  const proto = incoming.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const forwarded = new Headers({ "content-type": "application/json" });
  for (const name of FORWARDED) {
    const value = incoming.get(name);
    if (value) forwarded.set(name, value);
  }
  if (!forwarded.has("origin")) forwarded.set("origin", `${proto}://${host}`);

  try {
    const res = await auth.handler(
      new Request(`${proto}://${host}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: forwarded,
        body: JSON.stringify({ email, callbackURL: "/account" }),
      }),
    );
    if (res.status === 429) {
      return { status: "error", email, message: "Too many attempts. Wait a minute and try again." };
    }
    if (!res.ok) return { status: "error", email, message: "We couldn't send the link. Try again." };
    return { status: "sent", email };
  } catch {
    return { status: "error", email, message: "Something went wrong. Please try again." };
  }
}
