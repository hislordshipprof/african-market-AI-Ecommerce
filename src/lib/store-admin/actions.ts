"use server";

import { z } from "zod";
import { requireStoreOwner } from "./session";
import { parseInput, readFormFields } from "../security/parse-input";
import {
  createInvite,
  removeStoreMember,
  type StoreRole,
} from "../invite/service";
import { checkInviteRateLimit } from "../invite/rate-limit";
import { resolveAuthBaseUrl } from "../auth";

export async function inviteMemberAction(formData: FormData) {
  const session = await requireStoreOwner();
  const fields = parseInput(z.strictObject({
    email: z.string().max(320).nullable(),
  }), readFormFields(formData, ["email"]));
  const email = fields.ok ? fields.data.email : null;

  if (!email) {
    return { error: "Email is required" };
  }

  const role: StoreRole = "staff";

  const rateCheck = await checkInviteRateLimit(session.store.id);
  if (!rateCheck.allowed) {
    return { error: "rate_limit_exceeded" };
  }

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
  const target = parseInput(z.string().min(1).max(200), targetUserId);
  if (!target.ok) return { error: "Failed to remove member" };

  try {
    return await removeStoreMember(
      session.store.id,
      target.data,
      session.user.id,
      session.user.email,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to remove member";
    return { error: message };
  }
}
