import { authPrisma } from "../db";
import { sendEmail } from "./send";

/** One email to every platform admin. The key makes a retry send nothing new; a failed send never throws. */
export async function emailPlatformAdmins(subject: string, html: string, key: string): Promise<void> {
  const admins = await authPrisma.user.findMany({ where: { role: "platform_admin" }, select: { email: true } });
  await Promise.allSettled(
    admins.map((admin) => sendEmail({ to: admin.email, subject, html, idempotencyKey: `${key}-${admin.email}` })),
  );
}
