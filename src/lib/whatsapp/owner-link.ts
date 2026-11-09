import { findVerifiedOwnerLink, platformAdminTransaction, storeScoped, storeScopedTransaction } from "../db";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { generateLinkCode, hashLinkCode, LINK_CODE_TTL_MINUTES, phoneKey } from "./code";
import { WhatsAppNotConfiguredError, whatsappErrorCode } from "./errors";
import { canSendWhatsApp, sendWhatsAppMessage } from "./index";
import { e164Digits, lastFour, normalizeOwnerPhone } from "./phone";
import { ownerLinkCodeMessage } from "./templates";
import { Prisma } from "@prisma/client";

export const NOT_SET_UP_ERROR = "WhatsApp isn't set up yet";
export const SEND_FAILED_ERROR = "We couldn't send the code. Check the number and try again.";
export const TOO_MANY_CODES_ERROR = "Too many codes sent. Try again in an hour.";

const HOUR_MS = 60 * 60 * 1000;
const SENDS_PER_STORE_PER_HOUR = 5;
const SENDS_PER_NUMBER_PER_HOUR = 3;
const TTL = Prisma.raw(`INTERVAL '${LINK_CODE_TTL_MINUTES} minutes'`);

export interface OwnerLinkView {
  phoneNumber: string;
  verified: boolean;
  verifiedAt: Date | null;
  /** A code was sent and can still be used. */
  codeLive: boolean;
}

interface Owner {
  storeId: string;
  userId: string;
  actorEmail: string;
}

function logLink(event: string, storeId: string, phone: string, extra: Record<string, string> = {}): void {
  console.info(JSON.stringify({ event, storeId, phone: lastFour(phone), ...extra }));
}

/**
 * Starts (or restarts) linking the owner's number: replaces the owner's row
 * with an unverified one carrying a fresh code hash, then sends the code by
 * the authentication template. The answer is the same whether or not the
 * number is linked at another store. A failed send clears the code.
 */
export async function startOwnerLink(owner: Owner, rawPhone: string): Promise<{ ok: true } | { error: string }> {
  const phone = normalizeOwnerPhone(rawPhone);
  if (!phone.ok) return { error: phone.error };
  if (!canSendWhatsApp()) return { error: NOT_SET_UP_ERROR };

  const perStore = await takeRateLimit(`wa-link-store:${owner.storeId}`, SENDS_PER_STORE_PER_HOUR, HOUR_MS);
  if (!perStore.ok) return { error: TOO_MANY_CODES_ERROR };
  const perNumber = await takeRateLimit(`wa-link-number:${phoneKey(phone.e164)}`, SENDS_PER_NUMBER_PER_HOUR, HOUR_MS);
  if (!perNumber.ok) return { error: TOO_MANY_CODES_ERROR };

  const code = generateLinkCode();
  const codeHash = hashLinkCode(owner.storeId, owner.userId, code);
  const digits = e164Digits(phone.e164);

  const linkId = await storeScopedTransaction(owner.storeId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO owner_whatsapp_links (
        id, store_id, user_id, phone_number, wa_id, verified, verified_at,
        verification_code_hash, verification_expires_at, verification_attempts, created_at, updated_at
      ) VALUES (
        ${crypto.randomUUID()}, ${owner.storeId}, ${owner.userId}, ${phone.e164}, ${digits}, false, NULL,
        ${codeHash}, (now() AT TIME ZONE 'UTC') + ${TTL}, 0, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
      )
      ON CONFLICT (store_id, user_id) DO UPDATE SET
        phone_number = EXCLUDED.phone_number,
        wa_id = EXCLUDED.wa_id,
        verified = false,
        verified_at = NULL,
        verification_code_hash = EXCLUDED.verification_code_hash,
        verification_expires_at = EXCLUDED.verification_expires_at,
        verification_attempts = 0,
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error("owner link upsert returned no row");
    await tx.auditLog.create({
      data: {
        storeId: owner.storeId,
        actorId: owner.userId,
        actorEmail: owner.actorEmail,
        action: "whatsapp_link.start",
        entityType: "owner_whatsapp_link",
        entityId: id,
        after: { phoneLastFour: lastFour(phone.e164) },
      },
    });
    return id;
  });

  let waId: string | null;
  try {
    ({ waId } = await sendWhatsAppMessage(ownerLinkCodeMessage(digits, code)));
  } catch (error) {
    await storeScoped(owner.storeId).ownerWhatsAppLink.updateMany({
      where: { id: linkId, verified: false },
      data: { verificationCodeHash: null, verificationExpiresAt: null },
    });
    logLink("whatsapp_link_send_failed", owner.storeId, phone.e164, { code: whatsappErrorCode(error) });
    return { error: error instanceof WhatsAppNotConfiguredError ? NOT_SET_UP_ERROR : SEND_FAILED_ERROR };
  }

  if (waId && waId !== digits) {
    try {
      await storeScoped(owner.storeId).ownerWhatsAppLink.updateMany({
        where: { id: linkId, verified: false },
        data: { waId },
      });
    } catch {
      // The digits still match for most numbers; the owner can resend.
      logLink("whatsapp_link_wa_id_update_failed", owner.storeId, phone.e164);
    }
  }
  logLink("whatsapp_link_code_sent", owner.storeId, phone.e164);
  return { ok: true };
}

export async function removeOwnerLink(owner: Owner): Promise<{ ok: true }> {
  await storeScopedTransaction(owner.storeId, async (tx) => {
    const removed = await tx.$queryRaw<Array<{ id: string }>>`
      DELETE FROM owner_whatsapp_links
      WHERE store_id = ${owner.storeId} AND user_id = ${owner.userId}
      RETURNING id
    `;
    if (removed[0]) {
      await tx.auditLog.create({
        data: {
          storeId: owner.storeId,
          actorId: owner.userId,
          actorEmail: owner.actorEmail,
          action: "whatsapp_link.remove",
          entityType: "owner_whatsapp_link",
          entityId: removed[0].id,
        },
      });
    }
  });
  return { ok: true };
}

export async function getOwnerLink(storeId: string, userId: string): Promise<OwnerLinkView | null> {
  const rows = await storeScopedTransaction(storeId, (tx) =>
    tx.$queryRaw<Array<{ phone_number: string; verified: boolean; verified_at: Date | null; code_live: boolean }>>`
      SELECT phone_number, verified, verified_at,
        (verification_code_hash IS NOT NULL
          AND verification_expires_at > (now() AT TIME ZONE 'UTC')) AS code_live
      FROM owner_whatsapp_links
      WHERE store_id = ${storeId} AND user_id = ${userId}
    `,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    phoneNumber: row.phone_number,
    verified: row.verified,
    verifiedAt: row.verified_at,
    codeLive: row.code_live === true,
  };
}

/**
 * The store and owner membership for a verified WhatsApp number (E.164 or
 * wa_id). Null for an unknown, unverified, or no-longer-owner number.
 */
export async function resolveOwnerByPhone(
  phone: string,
): Promise<{ storeId: string; userId: string; membership: { role: string } } | null> {
  const digits = phone.replace(/\D/g, "");
  if (!/^\d{8,15}$/.test(digits)) return null;
  const link = await platformAdminTransaction((tx) => findVerifiedOwnerLink(tx, digits));
  if (!link) return null;
  return { storeId: link.storeId, userId: link.userId, membership: { role: link.role } };
}
