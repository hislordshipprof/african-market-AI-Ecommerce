import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { auth } from "../auth";

type AdminCheck =
  | { ok: true; session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>> }
  | { ok: false; reason: "sign-in" | "enroll-2fa" | "verify-2fa" };

async function checkPlatformAdmin(opts?: { allowUnenrolled2FA?: boolean }): Promise<AdminCheck> {
  const reqHeaders = await headers();

  const session = await auth.api.getSession({
    headers: reqHeaders,
    query: { disableCookieCache: true },
  });

  if (!session || session.user.role !== "platform_admin") {
    return { ok: false, reason: "sign-in" };
  }

  if (!opts?.allowUnenrolled2FA && !session.user.twoFactorEnabled) {
    return { ok: false, reason: "enroll-2fa" };
  }

  if (session.user.twoFactorEnabled && !session.session.twoFactorVerified) {
    return { ok: false, reason: "verify-2fa" };
  }

  return { ok: true, session };
}

export async function requirePlatformAdmin(opts?: { allowUnenrolled2FA?: boolean }) {
  const check = await checkPlatformAdmin(opts);
  if (!check.ok) redirect(check.reason === "enroll-2fa" ? "/admin/enroll-2fa" : "/admin/sign-in");
  return check.session;
}

/** Route-handler variant: a JSON 401/403 to return, or null when the caller is a verified platform admin. */
export async function platformAdminApiDenial(): Promise<NextResponse | null> {
  const check = await checkPlatformAdmin();
  if (check.ok) return null;
  if (check.reason === "sign-in") {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return NextResponse.json({ error: "Two-factor authentication required" }, { status: 403 });
}
