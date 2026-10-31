import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "../auth";

export async function requirePlatformAdmin(opts?: { allowUnenrolled2FA?: boolean }) {
  const reqHeaders = await headers();
  const hasCookie = reqHeaders.has("cookie");
  const cookieSnippet = reqHeaders.get("cookie")?.slice(0, 80) ?? "(none)";

  const session = await auth.api.getSession({
    headers: reqHeaders,
    query: { disableCookieCache: true },
  });

  // TEMP DIAGNOSTIC — remove after CI is green
  console.log("[requirePlatformAdmin]", {
    hasCookie,
    cookieSnippet,
    hasSession: !!session,
    userId: session?.user?.id?.slice(0, 8),
    role: session?.user?.role,
    twoFA: session?.session?.twoFactorVerified,
  });

  if (!session) {
    redirect("/admin/sign-in");
  }

  if (session.user.role !== "platform_admin") {
    redirect("/admin/sign-in");
  }

  if (!opts?.allowUnenrolled2FA && !session.user.twoFactorEnabled) {
    redirect("/admin/enroll-2fa");
  }

  if (session.user.twoFactorEnabled && !session.session.twoFactorVerified) {
    redirect("/admin/sign-in");
  }

  return session;
}
