"use server";

import { z } from "zod";
import { requireStoreOwner, twoFactorStepUp } from "./session";
import { parseInput, readFormFields } from "../security/parse-input";
import {
  copyInviteLink,
  createInvite,
  inviteNotEmailed,
  removeStoreMember,
  resendInvite,
  revokeInvite,
  type SavedInvite,
  type StoreRole,
} from "../invite/service";
import { checkInviteRateLimit } from "../invite/rate-limit";
import { resolveAuthBaseUrl } from "../auth";

const INVITE_RATE_LIMITED = "Too many invites this hour. Try again later.";

/** The link goes back only when the email did not, so the owner can share it by hand. */
function savedInviteResult(saved: SavedInvite) {
  return saved.emailed
    ? { success: true as const, id: saved.id }
    : { success: true as const, id: saved.id, warning: inviteNotEmailed(), inviteUrl: saved.inviteUrl };
}

export async function inviteMemberAction(formData: FormData) {
  const session = await requireStoreOwner();
  const stepUp = await twoFactorStepUp(session);
  if (stepUp) return stepUp;
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
    return { error: INVITE_RATE_LIMITED };
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
    return savedInviteResult(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send invite";
    return { error: message };
  }
}

export async function removeMemberAction(targetUserId: string) {
  const session = await requireStoreOwner();
  const stepUp = await twoFactorStepUp(session);
  if (stepUp) return stepUp;
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

export async function resendInviteAction(inviteId: string) {
  const session = await requireStoreOwner();
  const stepUp = await twoFactorStepUp(session);
  if (stepUp) return stepUp;
  const target = parseInput(z.string().min(1).max(200), inviteId);
  if (!target.ok) return { error: "Invitation not found" };

  const rateCheck = await checkInviteRateLimit(session.store.id);
  if (!rateCheck.allowed) return { error: INVITE_RATE_LIMITED };

  const result = await resendInvite({
    storeId: session.store.id,
    inviteId: target.data,
    actorId: session.user.id,
    actorEmail: session.user.email,
    baseUrl: resolveAuthBaseUrl(),
    storeSlug: session.store.slug,
    storeName: session.store.name,
  });
  return "error" in result ? result : savedInviteResult(result);
}

export async function revokeInviteAction(inviteId: string) {
  const session = await requireStoreOwner();
  const stepUp = await twoFactorStepUp(session);
  if (stepUp) return stepUp;
  const target = parseInput(z.string().min(1).max(200), inviteId);
  if (!target.ok) return { error: "Invitation not found" };
  return revokeInvite(session.store.id, target.data, session.user.id, session.user.email);
}

/** The owner shares a staff invite by hand when the email cannot reach anyone (#839); the earlier link stops working. */
export async function copyInviteLinkAction(inviteId: string) {
  const session = await requireStoreOwner();
  const stepUp = await twoFactorStepUp(session);
  if (stepUp) return stepUp;
  const target = parseInput(z.string().min(1).max(200), inviteId);
  if (!target.ok) return { error: "Invitation not found" };

  const rateCheck = await checkInviteRateLimit(session.store.id);
  if (!rateCheck.allowed) return { error: INVITE_RATE_LIMITED };

  return copyInviteLink({
    storeId: session.store.id,
    inviteId: target.data,
    actorId: session.user.id,
    actorEmail: session.user.email,
    baseUrl: resolveAuthBaseUrl(),
    storeSlug: session.store.slug,
  });
}
