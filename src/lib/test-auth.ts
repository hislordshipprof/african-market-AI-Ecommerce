import { auth } from "./auth";
import { authPrisma } from "./db";

/** Tests only: auth requests through the real handler, and the magic links they leave. */
export const AUTH_BASE = "http://localhost:3000/api/auth";

export async function authPost(
  path: string,
  body: unknown,
  cookies?: string,
  extra?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (cookies) headers.cookie = cookies;
  return auth.handler(
    new Request(`${AUTH_BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

/**
 * Tests only: an email-and-password account like the old public sign-up made (unverified), created
 * server-side because /sign-up/email is closed. Returns the user id.
 */
export async function createTestUser(input: {
  email: string;
  password: string;
  name: string;
  emailVerified?: boolean;
}): Promise<string> {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({
    email: input.email.toLowerCase(),
    name: input.name,
    emailVerified: input.emailVerified ?? false,
  }, { method: "email-password" });
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(input.password),
  });
  return user.id;
}

/** Tests only: creates the account, then signs in by password. Returns the sign-in response. */
export async function testSignUp(
  input: { email: string; password: string; name: string },
  extra?: Record<string, string>,
): Promise<Response> {
  await createTestUser(input);
  return authPost("/sign-in/email", { email: input.email, password: input.password }, undefined, extra);
}

export async function authGet(
  url: string,
  cookies?: string,
  extra?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { ...extra };
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(url, { headers, redirect: "manual" }));
}

export function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

/** The newest magic link sent to this email, or null. */
export async function latestMagicLink(email: string): Promise<{ token: string; id: string } | null> {
  const rows = await authPrisma.verification.findMany({
    where: { identifier: { startsWith: "magic-link:" } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const row = rows.find((item) => item.value.includes(email));
  if (!row) return null;
  return { id: row.id, token: row.identifier.replace(/^magic-link:/, "") };
}

/**
 * The magic-link email opens the confirm page; its Continue form submits the
 * same params to the verify endpoint. Returns that verify URL, or null if no link.
 */
export function verifyUrlFromEmail(html: string | undefined): string | null {
  const href = html?.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  if (!href) return null;
  const confirm = new URL(href);
  if (confirm.pathname !== "/account/sign-in/confirm") {
    throw new Error(`magic-link email links to ${confirm.pathname}, not the confirm page`);
  }
  return `${confirm.origin}/api/auth/magic-link/verify${confirm.search}`;
}
