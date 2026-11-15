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

async function isPrivilegedRecord(
  user: { id: string; role: string; twoFactorEnabled: boolean } | null,
): Promise<boolean> {
  if (!user) return false;
  const memberships = await platformAdmin.storeMembership.findMany({
    where: { userId: user.id },
    select: { id: true },
    take: 1,
  });
  return userIsPrivileged({ ...user, memberships });
}

const PRIVILEGE_FIELDS = { id: true, role: true, twoFactorEnabled: true } as const;

export async function isPrivilegedUser(userId: string): Promise<boolean> {
  return isPrivilegedRecord(
    await authPrisma.user.findUnique({ where: { id: userId }, select: PRIVILEGE_FIELDS }),
  );
}

export async function isPrivilegedEmail(email: string): Promise<boolean> {
  return isPrivilegedRecord(
    await authPrisma.user.findFirst({ where: { email }, select: PRIVILEGE_FIELDS }),
  );
}
