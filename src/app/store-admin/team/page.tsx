import { requireStoreOwner } from "@/lib/store-admin/session";
import { listStoreMembers, listStoreInvites } from "@/lib/invite/service";
import { readOnlyStaffIds, staffLimit, storePlan } from "@/lib/billing/plan";
import { TeamManagement } from "./team-management";

export default async function TeamPage() {
  const session = await requireStoreOwner();
  const [members, invites, plan] = await Promise.all([
    listStoreMembers(session.store.id),
    listStoreInvites(session.store.id),
    storePlan(session.store.id),
  ]);
  const readOnly = readOnlyStaffIds(plan, members);

  return (
    <TeamManagement
      storeName={session.store.name}
      storeSlug={session.store.slug}
      currentUserId={session.user.id}
      members={members.map((m) => ({
        userId: m.userId,
        name: m.user.name ?? m.user.email,
        email: m.user.email,
        role: m.role,
        readOnly: readOnly.has(m.userId),
      }))}
      staffSeats={staffLimit(plan)}
      invites={invites.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        expiresAt: inv.expiresAt.toISOString(),
      }))}
    />
  );
}
