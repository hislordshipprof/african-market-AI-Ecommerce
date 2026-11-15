import {
  claimInboundWhatsAppMessage,
  findVerifiedOwnerLink,
  platformAdminTransaction,
  recordOwnerLinkBsuid,
  verifyOwnerLinkByCode,
} from "../db";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { scheduleAfterResponse } from "../schedule-after-response";
import { LINK_CODE_PATTERN, messageRef, phoneKey } from "./code";
import { sendWhatsAppMessage } from "./index";
import { ownerMessageReply } from "./owner-handler";
import { isBsuid, lastFour } from "./phone";
import type { InboundMessage } from "./webhook-payload";

export const NOT_LINKED_REPLY = "This number isn't linked to a store";
export const WRONG_CODE_REPLY = "That code is wrong or has expired. Request a new one in your store admin.";

const HOUR_MS = 60 * 60 * 1000;
const NOT_LINKED_REPLIES_PER_HOUR = 3;
const WA_ID_SHAPE = /^\d{8,15}$/;
/** Message types that are not something said to the business: they get no reply. */
const NO_REPLY_TYPES = new Set(["edit", "revoke", "reaction", "system"]);

type Outcome =
  | { kind: "duplicate" }
  | { kind: "ignored" }
  | { kind: "unaddressable_sender" }
  | { kind: "verified"; storeName: string }
  | { kind: "wrong_code" }
  | { kind: "owner"; storeName: string }
  | { kind: "unlinked" };

/** Message digest, sender's last four digits (or a BSUID digest) and outcome only. */
function log(message: InboundMessage, outcome: string): void {
  const from = message.from ? lastFour(message.from) : messageRef(message.fromUserId ?? "");
  console.info(JSON.stringify({ event: "whatsapp_inbound", message: messageRef(message.id), from, outcome }));
}

/**
 * Handles one inbound message: claims its id, tries a link code, and finds a
 * verified owner by wa_id or BSUID, in one transaction (a failure rolls back
 * the claim, so the route answers 500 and Meta redelivers). The reply goes out
 * after commit and after the response, to the wa_id, or to the BSUID when Meta
 * sent no number; a failed reply is logged and not retried. Edits, revokes,
 * reactions, system notices and group messages get no reply.
 */
export async function handleInboundMessage(message: InboundMessage): Promise<void> {
  const waId = message.from && WA_ID_SHAPE.test(message.from) ? message.from : null;
  const bsuid = message.fromUserId && isBsuid(message.fromUserId) ? message.fromUserId : null;

  const outcome = await platformAdminTransaction(async (tx): Promise<Outcome> => {
    if (!(await claimInboundWhatsAppMessage(tx, message.id))) return { kind: "duplicate" };
    if (!waId && !bsuid) return { kind: "unaddressable_sender" };
    if (message.inGroup || NO_REPLY_TYPES.has(message.type)) return { kind: "ignored" };
    const owner = await findVerifiedOwnerLink(tx, { waId, bsuid });
    if (owner && waId && bsuid && owner.bsuid !== bsuid) await recordOwnerLinkBsuid(tx, owner.linkId, bsuid);
    // A verified owner's six-digit text is a code only if it matches a code
    // sent to them; otherwise it is an ordinary message and counts no attempt,
    // though a miss on their own link is still told it was wrong.
    const text = message.text?.trim() ?? "";
    if (waId && LINK_CODE_PATTERN.test(text)) {
      const verified = await verifyOwnerLinkByCode(tx, { waId, bsuid }, text, { countMisses: !owner });
      if (verified.kind === "verified") return { kind: "verified", storeName: verified.storeName };
      if (verified.kind === "wrong_or_expired") {
        const ownRow = owner && verified.candidates.some(
          (candidate) => candidate.storeId === owner.storeId && candidate.userId === owner.userId,
        );
        if (!owner || ownRow) return { kind: "wrong_code" };
      }
    }
    if (owner) return { kind: "owner", storeName: owner.storeName };
    // A username user known only by BSUID is not told anything about linking.
    if (!waId) return { kind: "unaddressable_sender" };
    return { kind: "unlinked" };
  });

  log(message, outcome.kind);

  let body: string;
  switch (outcome.kind) {
    case "duplicate":
    case "ignored":
    case "unaddressable_sender":
      return;
    case "verified":
      body = `Your number is now linked to ${outcome.storeName}.`;
      break;
    case "wrong_code":
      body = WRONG_CODE_REPLY;
      break;
    case "owner":
      body = ownerMessageReply({ storeName: outcome.storeName });
      break;
    case "unlinked": {
      // The claim has committed: a limiter failure here must not answer 500,
      // or the redelivery is a duplicate and the sender never gets a reply.
      let allowed: boolean;
      try {
        allowed = (await takeRateLimit(`wa-unlinked:${phoneKey(waId ?? "")}`, NOT_LINKED_REPLIES_PER_HOUR, HOUR_MS)).ok;
      } catch (error) {
        console.error(JSON.stringify({
          event: "whatsapp_reply_rate_limit_failed",
          message: messageRef(message.id),
          error: error instanceof Error ? error.name : "unknown",
        }));
        return;
      }
      if (!allowed) return;
      body = NOT_LINKED_REPLY;
      break;
    }
  }

  const to = waId ?? bsuid;
  if (!to) return;
  scheduleAfterResponse(() => sendWhatsAppMessage({ type: "text", to, body }), "whatsapp_reply_failed");
}
