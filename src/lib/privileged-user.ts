import { authPrisma, platformAdmin } from "./db";

/**
 * Staff, platform admins and anyone with 2FA are privileged: they never sign in by
 * magic link and never claim guest orders. Read-only check on users and memberships.
 */
export function userIsPrivileged(user: {
  role: string;
  twoFactorEnabled: boolean;
  memberships: { id: string }[];
}): boolean {
  if (user.role !== "customer" || user.twoFactorEnabled) return true;
  return user.memberships.length > 0;
}

export async function isPrivilegedUser(userId: string): Promise<boolean> {
  const user = await authPrisma.user.findUnique({
    where: { id: userId },
    select: { role: true, twoFactorEnabled: true },
  });
  if (!user) return false;
  const memberships = await platformAdmin.storeMembership.findMany({
    where: { userId },
    select: { id: true },
    take: 1,
  });
  return userIsPrivileged({ ...user, memberships });
}

export async function isPrivilegedEmail(email: string): Promise<boolean> {
  const user = await authPrisma.user.findFirst({
    where: { email },
    select: { id: true, role: true, twoFactorEnabled: true },
  });
  if (!user) return false;
  const memberships = await platformAdmin.storeMembership.findMany({
    where: { userId: user.id },
    select: { id: true },
    take: 1,
  });
  return userIsPrivileged({ ...user, memberships });
}
