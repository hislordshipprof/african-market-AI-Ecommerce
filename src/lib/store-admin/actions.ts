"use server";

import { requireStoreOwner, requireStoreMember } from "./session";
import {
  createInvite,
  removeStoreMember,
  listStoreMembers,
  listStoreInvites,
  type StoreRole,
} from "../invite/service";
import { resolveAuthBaseUrl } from "../auth";

export async function inviteMemberAction(formData: FormData) {
  const session = await requireStoreOwner();
  const email = formData.get("email") as string | null;
  const role = formData.get("role") as StoreRole | null;

  if (!email || !role || !["owner", "staff"].includes(role)) {
    return { error: "Email and valid role are required" };
  }

  try {
    const result = await createInvite({
      storeId: session.store.id,
      email,
      role,
      invitedById: session.user.id,
      baseUrl: resolveAuthBaseUrl(),
      storeSlug: session.store.slug,
      storeName: session.store.name,
    });
    return { success: true, id: result.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send invite";
    return { error: message };
  }
}

export async function removeMemberAction(targetUserId: string) {
  const session = await requireStoreOwner();

  const result = await removeStoreMember(
    session.store.id,
    targetUserId,
    session.user.id,
    session.user.email,
  );

  return result;
}

export async function listMembersAction() {
  const session = await requireStoreMember();
  return listStoreMembers(session.store.id);
}

export async function listInvitesAction() {
  const session = await requireStoreOwner();
  return listStoreInvites(session.store.id);
}
