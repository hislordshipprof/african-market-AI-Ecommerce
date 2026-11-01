"use server";

import { requireStoreOwner } from "./session";
import {
  createInvite,
  removeStoreMember,
  type StoreRole,
} from "../invite/service";
import { resolveAuthBaseUrl } from "../auth";

export async function inviteMemberAction(formData: FormData) {
  const session = await requireStoreOwner();
  const email = formData.get("email") as string | null;

  if (!email) {
    return { error: "Email is required" };
  }

  const role: StoreRole = "staff";

  try {
    const result = await createInvite({
      storeId: session.store.id,
      email,
      role,
      invitedById: session.user.id,
      actorEmail: session.user.email,
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

  try {
    return await removeStoreMember(
      session.store.id,
      targetUserId,
      session.user.id,
      session.user.email,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to remove member";
    return { error: message };
  }
}
