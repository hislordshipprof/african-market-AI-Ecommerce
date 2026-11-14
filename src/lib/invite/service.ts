import { randomBytes, createHash } from "crypto";
import {
  authPrisma,
  platformAdmin,
  platformAdminTransaction,
  storeScoped,
  lockStoreRow,
} from "../db";
import { sendEmail } from "../email/send";
import { normalizeEmail } from "../email";
import { effectivePlan, staffLimit } from "../billing/plan";
import { auth } from "../auth";

const INVITE_EXPIRY_HOURS = 72;
const TOKEN_BYTES = 32;

export type StoreRole = "owner" | "staff";

export const STAFF_LIMIT_MESSAGE = `The Starter plan includes the owner and ${staffLimit("starter")} staff. Upgrade to Pro for unlimited staff.`;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(TOKEN_BYTES).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export interface CreateInviteInput {
  storeId: string;
  email: string;
  role: StoreRole;
  invitedById: string;
  actorEmail: string;
  baseUrl: string;
  storeSlug: string;
  storeName: string;
}

export async function createInvite(input: CreateInviteInput): Promise<{ id: string; tokenHash: string }> {
  const email = normalizeEmail(input.email);
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  const invite = await platformAdminTransaction(async (tx) => {
    const existing = await tx.storeMembership.findFirst({
      where: { storeId: input.storeId, user: { email } },
    });
    if (existing) {
      throw new Error("User is already a member of this store");
    }

    if (input.role === "staff") {
      await lockStoreRow(tx, input.storeId);
      const subscription = await tx.storeSubscription.findUnique({
        where: { storeId: input.storeId },
        select: { plan: true, status: true },
      });
      const limit = staffLimit(effectivePlan(subscription));
      if (limit !== null) {
        const [staff, invited] = await Promise.all([
          tx.storeMembership.count({ where: { storeId: input.storeId, role: { not: "owner" } } }),
          tx.storeInvite.count({
            where: { storeId: input.storeId, role: "staff", usedAt: null, expiresAt: { gt: new Date() }, email: { not: email } },
          }),
        ]);
        if (staff + invited >= limit) throw new Error(STAFF_LIMIT_MESSAGE);
      }
    }

    const pendingInvite = await tx.storeInvite.findFirst({
      where: { storeId: input.storeId, email, usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (pendingInvite) {
      await tx.storeInvite.update({
        where: { id: pendingInvite.id },
        data: { usedAt: new Date() },
      });
    }

    const created = await tx.storeInvite.create({
      data: {
        storeId: input.storeId,
        email,
        role: input.role,
        tokenHash: hash,
        expiresAt,
        invitedById: input.invitedById,
      },
    });

    await tx.auditLog.create({
      data: {
        storeId: input.storeId,
        actorId: input.invitedById,
        actorEmail: input.actorEmail,
        action: "invite.create",
        entityType: "store_invite",
        entityId: created.id,
        after: { email, role: input.role },
      },
    });

    return created;
  });

  const inviteUrl = `${input.baseUrl}/invite/${raw}?store=${input.storeSlug}`;

  await sendEmail({
    to: email,
    subject: `You're invited to ${input.storeName}`,
    html: buildInviteHtml(input.storeName, input.role, inviteUrl),
  });

  return { id: invite.id, tokenHash: hash };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildInviteHtml(storeName: string, role: string, url: string): string {
  const safeName = escapeHtml(storeName);
  const safeRole = escapeHtml(role);
  const safeUrl = escapeHtml(url);
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 16px;">
      <h1 style="font-size: 22px; font-weight: 700; color: #15201A; margin-bottom: 8px;">
        Join ${safeName}
      </h1>
      <p style="font-size: 16px; color: #55625A; line-height: 1.5; margin-bottom: 24px;">
        You've been invited as <strong>${safeRole}</strong> for ${safeName} on the African Markets Platform.
        Click the button below to set up your account.
      </p>
      <a href="${safeUrl}" style="display: inline-block; background: #1F5A43; color: #fff; text-decoration: none; padding: 12px 32px; border-radius: 999px; font-size: 16px; font-weight: 600;">
        Accept invitation
      </a>
      <p style="font-size: 13px; color: #55625A; margin-top: 24px;">
        This invitation expires in 72 hours. If you didn't expect this email, you can ignore it.
      </p>
    </div>
  `;
}

export interface ValidatedInvite {
  id: string;
  storeId: string;
  email: string;
  role: StoreRole;
  storeName: string;
  storeSlug: string;
}

export async function validateInviteToken(rawToken: string): Promise<ValidatedInvite | { error: string }> {
  const tokenHash = hashToken(rawToken);

  const invite = await platformAdmin.storeInvite.findUnique({
    where: { tokenHash },
    include: { store: { select: { name: true, slug: true } } },
  });

  if (!invite) {
    return { error: "Invalid invitation link" };
  }

  if (invite.usedAt) {
    return { error: "This invitation has already been used" };
  }

  if (new Date() > invite.expiresAt) {
    return { error: "This invitation has expired" };
  }

  return {
    id: invite.id,
    storeId: invite.storeId,
    email: invite.email,
    role: invite.role as StoreRole,
    storeName: invite.store.name,
    storeSlug: invite.store.slug,
  };
}

/**
 * A shopper who only signed in by magic link has no password, so the invite's password
 * sign-in can never succeed. The invite token was mailed to that address, which proves the
 * mailbox as a magic link does: add a password to an account that has none. Never replaces one.
 */
export async function setInviteePassword(
  rawToken: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const invite = await validateInviteToken(rawToken);
  if ("error" in invite) return { ok: false, error: invite.error };
  const ctx = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (password.length < minPasswordLength || password.length > maxPasswordLength) {
    return { ok: false, error: `Use a password of ${minPasswordLength} to ${maxPasswordLength} characters.` };
  }
  const user = await authPrisma.user.findFirst({
    where: { email: normalizeEmail(invite.email) },
    select: { id: true, accounts: { where: { providerId: "credential" }, select: { id: true } } },
  });
  if (!user || user.accounts.length > 0) return { ok: true };
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(password),
  });
  return { ok: true };
}

export async function acceptInvite(
  rawToken: string,
  userId: string,
  userEmail: string,
): Promise<{ storeId: string; storeSlug: string; role: StoreRole } | { error: string }> {
  const tokenHash = hashToken(rawToken);

  return platformAdminTransaction(async (tx) => {
    const invite = await tx.storeInvite.findUnique({
      where: { tokenHash },
      include: { store: { select: { slug: true } } },
    });

    if (!invite) {
      return { error: "Invalid invitation link" };
    }

    if (invite.usedAt) {
      return { error: "This invitation has already been used" };
    }

    if (new Date() > invite.expiresAt) {
      return { error: "This invitation has expired" };
    }

    if (normalizeEmail(userEmail) !== normalizeEmail(invite.email)) {
      return { error: "This invitation was sent to a different email address" };
    }

    const existingMembership = await tx.storeMembership.findUnique({
      where: { storeId_userId: { storeId: invite.storeId, userId } },
    });

    if (existingMembership) {
      await tx.storeInvite.update({
        where: { id: invite.id },
        data: { usedAt: new Date() },
      });
      return {
        storeId: invite.storeId,
        storeSlug: invite.store.slug,
        role: existingMembership.role as StoreRole,
      };
    }

    await tx.storeMembership.create({
      data: {
        storeId: invite.storeId,
        userId,
        role: invite.role,
      },
    });

    await tx.storeInvite.update({
      where: { id: invite.id },
      data: { usedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        storeId: invite.storeId,
        actorId: userId,
        actorEmail: userEmail,
        action: "membership.create",
        entityType: "store_membership",
        entityId: invite.storeId,
        after: { role: invite.role, inviteId: invite.id },
      },
    });

    return {
      storeId: invite.storeId,
      storeSlug: invite.store.slug,
      role: invite.role as StoreRole,
    };
  });
}

export async function removeStoreMember(
  storeId: string,
  targetUserId: string,
  actorId: string,
  actorEmail: string,
): Promise<{ success: true } | { error: string }> {
  return platformAdminTransaction(async (tx) => {
    const membership = await tx.storeMembership.findUnique({
      where: { storeId_userId: { storeId, userId: targetUserId } },
    });

    if (!membership) {
      return { error: "Member not found" };
    }

    if (membership.role === "owner") {
      await lockStoreRow(tx, storeId);
      const ownerCount = await tx.storeMembership.count({
        where: { storeId, role: "owner" },
      });
      if (ownerCount <= 1) {
        return { error: "Cannot remove the last owner of a store" };
      }
    }

    await tx.storeMembership.delete({
      where: { storeId_userId: { storeId, userId: targetUserId } },
    });

    await tx.auditLog.create({
      data: {
        storeId,
        actorId,
        actorEmail,
        action: "membership.delete",
        entityType: "store_membership",
        entityId: storeId,
        before: { userId: targetUserId, role: membership.role },
      },
    });

    return { success: true as const };
  });
}

export async function listStoreMembers(storeId: string) {
  const scoped = storeScoped(storeId);
  return scoped.storeMembership.findMany({
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function listStoreInvites(storeId: string) {
  const scoped = storeScoped(storeId);
  return scoped.storeInvite.findMany({
    where: { usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
}

export { hashToken as _hashTokenForTesting };
