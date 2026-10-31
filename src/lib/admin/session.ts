import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "../auth";

export async function requirePlatformAdmin(opts?: { allowUnenrolled2FA?: boolean }) {
  const session = await auth.api.getSession({
    headers: await headers(),
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
