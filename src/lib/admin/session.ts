import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "../auth";

export async function requirePlatformAdmin() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/admin/sign-in");
  }

  if (session.user.role !== "platform_admin") {
    redirect("/admin/sign-in");
  }

  return session;
}
