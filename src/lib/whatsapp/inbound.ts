import { claimInboundWhatsAppMessage, findVerifiedOwnerLink, platformAdminTransaction, verifyOwnerLinkByCode } from "../db";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { scheduleAfterResponse } from "../schedule-after-response";
import { LINK_CODE_PATTERN, phoneKey } from "./code";
import { sendWhatsAppMessage } from "./index";
import { ownerMessageReply } from "./owner-handler";
import { lastFour } from "./phone";
import type { InboundMessage } from "./webhook-payload";

export const NOT_LINKED_REPLY = "This number isn't linked to a store";
export const WRONG_CODE_REPLY = "That code is wrong or has expired. Request a new one in your store admin.";

const HOUR_MS = 60 * 60 * 1000;
const NOT_LINKED_REPLIES_PER_HOUR = 3;
const WA_ID_SHAPE = /^\d{8,15}$/;

type Outcome =
  | { kind: "duplicate" }
  | { kind: "verified"; storeName: string }
  | { kind: "wrong_code" }
  | { kind: "owner"; storeName: string }
  | { kind: "unlinked" };

function log(messageId: string, from: string, outcome: string): void {
  console.info(JSON.stringify({ event: "whatsapp_inbound", messageId, from: lastFour(from), outcome }));
}

/**
 * Handles one inbound message: claims its id, tries a link code, and finds a
 * verified owner, in one transaction (a failure rolls back the claim, so the
 * route answers 500 and Meta redelivers). The reply goes out after commit and
 * after the response; a failed reply is logged and not retried.
 */
export async function handleInboundMessage(message: InboundMessage): Promise<void> {
  // A sender id that is not a phone-number wa_id (business-scoped user id)
  // cannot be matched to a link or addressed by number.
  if (!WA_ID_SHAPE.test(message.from)) {
    log(message.id, message.from, "unaddressable_sender");
    return;
  }

  const outcome = await platformAdminTransaction(async (tx): Promise<Outcome> => {
    if (!(await claimInboundWhatsAppMessage(tx, message.id))) return { kind: "duplicate" };
    // A verified owner's six-digit text is a code only if it matches a code
    // sent to them; otherwise it is an ordinary message and counts no attempt.
    const owner = await findVerifiedOwnerLink(tx, message.from);
    const text = message.text?.trim() ?? "";
    if (LINK_CODE_PATTERN.test(text)) {
      const verified = await verifyOwnerLinkByCode(tx, message.from, text, { countMisses: !owner });
      if (verified.kind === "verified") return { kind: "verified", storeName: verified.storeName };
      if (verified.kind === "wrong_or_expired" && !owner) return { kind: "wrong_code" };
    }
    if (owner) return { kind: "owner", storeName: owner.storeName };
    return { kind: "unlinked" };
  });

  log(message.id, message.from, outcome.kind);

  let body: string;
  switch (outcome.kind) {
    case "duplicate":
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
      const limit = await takeRateLimit(`wa-unlinked:${phoneKey(message.from)}`, NOT_LINKED_REPLIES_PER_HOUR, HOUR_MS);
      if (!limit.ok) return;
      body = NOT_LINKED_REPLY;
      break;
    }
  }

  const to = message.from;
  scheduleAfterResponse(() => sendWhatsAppMessage({ type: "text", to, body }), "whatsapp_reply_failed");
}
