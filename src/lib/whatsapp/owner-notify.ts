import { storeScoped } from "../db";
import { messageRef } from "./code";
import { whatsappErrorCode } from "./errors";
import { sendWhatsAppMessage } from "./index";
import { copilotTemplateMessage } from "./templates";

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OwnerRecipient {
  userId: string;
  /** The verified wa_id. */
  to: string;
  /** Meta's 24-hour window, from the owner's last message to the platform number. */
  windowOpen: boolean;
}

/**
 * The store's current owners with a verified Linked WhatsApp number who opted
 * in to alerts or the digest (#144). Read under the store's RLS, so another
 * store's owner is never a recipient.
 */
export async function optedInOwners(storeId: string, kind: "alerts" | "digest", now: Date): Promise<OwnerRecipient[]> {
  const links = await storeScoped(storeId).ownerWhatsAppLink.findMany({
    where: {
      verified: true,
      membership: { role: "owner" },
      ...(kind === "alerts" ? { optInAlerts: true } : { optInDigest: true }),
    },
    orderBy: { userId: "asc" },
    select: { userId: true, waId: true, lastInboundAt: true },
  });
  return links.map((link) => ({
    userId: link.userId,
    to: link.waId,
    windowOpen: link.lastInboundAt !== null && now.getTime() - link.lastInboundAt.getTime() < WINDOW_MS,
  }));
}

/**
 * Free text inside the owner's window, else the approved template with the
 * same facts. Never retried (Meta's send has no idempotency key); a failure is
 * logged with its code and returns false.
 */
export async function sendOwnerNotice(
  storeId: string,
  recipient: OwnerRecipient,
  notice: { text: string; template: { name: string; language: string }; values: string[] },
): Promise<boolean> {
  const message = recipient.windowOpen
    ? { type: "text" as const, to: recipient.to, body: notice.text.slice(0, 4096) }
    : copilotTemplateMessage(recipient.to, notice.template, notice.values);
  try {
    await sendWhatsAppMessage(message);
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      event: "whatsapp_owner_notice_failed",
      storeId,
      template: recipient.windowOpen ? null : notice.template.name,
      to: messageRef(recipient.to),
      code: whatsappErrorCode(error),
    }));
    return false;
  }
}
