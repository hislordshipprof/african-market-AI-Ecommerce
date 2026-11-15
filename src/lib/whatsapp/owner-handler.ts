import { storeScoped } from "../db";
import { chooseListing } from "../copilot/choices";
import { confirmProposal, rejectProposal } from "../copilot/confirm";
import { sendCopilotTurn } from "../copilot/turn";
import { FIXED_ERROR, MESSAGE_MAX, type ChoiceCard, type CopilotActor, type StockProposalCard } from "../copilot/types";
import { revalidateStorefront } from "../storefront/cache";
import { messageRef } from "./code";
import type { ListRow, OutboundMessage } from "./types";
import type { InboundMessage } from "./webhook-payload";

export const TYPE_YOUR_REPORT_REPLY =
  "Please type your stock report, for example \"restocked 20 bags of egusi\". Voice notes and photos are not read on WhatsApp yet.";
export const PROPOSAL_GONE_REPLY = "That change is no longer waiting. Send the report again if you still need it.";
export const REJECTED_REPLY = "Rejected. Nothing was changed.";

const MEDIA = new Set(["audio", "image", "video", "document", "sticker"]);
const ROW_TITLE_MAX = 24;
const MAX_ROWS = 10;

/** Reply-button and list-row ids. Ours alone: a tap's id is split on ":" and compared exactly, never matched as a pattern. */
const CONFIRM = "cp-confirm";
const REJECT = "cp-reject";
const CHOOSE = "cp-choose";

export interface VerifiedOwner {
  storeId: string;
  userId: string;
  email: string;
  storeName: string;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** WhatsApp bold is one asterisk. */
function whatsappText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

function changeText(card: StockProposalCard): string {
  if (card.kind === "set_status") return `${card.listingName}: mark as ${(card.afterStatus ?? "").replace(/_/g, " ")}`;
  const verb = { restock: "restock", counter_sale: "counter sale of", recount: "recount to" }[card.kind];
  const after = card.afterQty === null ? "" : ` (${card.beforeQty ?? 0} → ${card.afterQty})`;
  return `${card.listingName}: ${verb} ${card.quantity ?? 0}${after}`;
}

/** One proposal with Confirm and Reject reply buttons. Nothing changes until a tap. */
function proposalMessage(to: string, card: StockProposalCard): OutboundMessage {
  return {
    type: "interactive",
    to,
    body: clip(`${changeText(card)}\nConfirm to update your stock.`, 1024),
    buttons: [
      { id: `${CONFIRM}:${card.id}`, title: "Confirm" },
      { id: `${REJECT}:${card.id}`, title: "Reject" },
    ],
  };
}

/** A "which one?" choice as a list; a row's id names the stored choice, so the tap needs no model call. */
function choiceMessage(to: string, conversationId: string, messageId: string, choice: ChoiceCard): OutboundMessage | null {
  const rows: ListRow[] = choice.candidates.slice(0, MAX_ROWS).map((candidate) => ({
    id: `${CHOOSE}:${conversationId}:${messageId}:${candidate.listingId}`,
    title: clip(candidate.name, ROW_TITLE_MAX),
  }));
  if (rows.length === 0 || rows.some((row) => row.id.length > 200)) return null;
  return {
    type: "list",
    to,
    body: choice.nearOnly ? "Did you mean one of these?" : "More than one item matches. Which one?",
    button: "Choose",
    rows,
  };
}

/** The owner's latest conversation, so WhatsApp and the copilot page share one history. */
async function latestConversationId(storeId: string, userId: string): Promise<string | undefined> {
  const latest = await storeScoped(storeId).copilotConversation.findFirst({
    where: { userId },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  return latest?.id;
}

async function reportTurn(owner: VerifiedOwner, message: InboundMessage, text: string, to: string): Promise<OutboundMessage[]> {
  if (text.length > MESSAGE_MAX) {
    return [{ type: "text", to, body: `Please send a shorter report, up to ${MESSAGE_MAX.toLocaleString("en-US")} characters.` }];
  }
  // A wamid can embed the sender's number, so the copilot's message id is its digest.
  const messageId = `wa-${messageRef(message.id)}`;
  const result = await sendCopilotTurn({
    storeId: owner.storeId,
    userId: owner.userId,
    email: owner.email,
    conversationId: await latestConversationId(owner.storeId, owner.userId),
    messageId,
    text,
  });
  if (!result.ok) return [{ type: "text", to, body: result.message }];
  const out: OutboundMessage[] = [{ type: "text", to, body: clip(whatsappText(result.reply), 4096) }];
  for (const card of result.proposals) if (card.state === "pending") out.push(proposalMessage(to, card));
  for (const choice of result.choices) {
    if (!choice.open) continue;
    const list = choiceMessage(to, result.conversationId, messageId, choice);
    if (list) out.push(list);
  }
  return out;
}

async function confirmTap(owner: VerifiedOwner, actor: CopilotActor, proposalId: string, to: string): Promise<OutboundMessage[]> {
  const result = await confirmProposal(owner.storeId, proposalId, actor);
  if (!result.ok) {
    const body = {
      not_found: PROPOSAL_GONE_REPLY,
      expired: "That change expired after 60 minutes. Send the report again.",
      stale: "That item changed since the report. Send the report again.",
      too_large: "That restock is too large to record.",
    }[result.code];
    return [{ type: "text", to, body }];
  }
  revalidateStorefront(owner.storeId);
  const { proposal, listing } = result;
  const now = listing.qty !== null && proposal.kind !== "set_status"
    ? `${listing.qty} in stock`
    : (listing.status ?? "").replace(/_/g, " ");
  return [{ type: "text", to, body: `Done. ${proposal.listingName} is now ${now}.` }];
}

async function rejectTap(owner: VerifiedOwner, actor: CopilotActor, proposalId: string, to: string): Promise<OutboundMessage[]> {
  const result = await rejectProposal(owner.storeId, proposalId, actor);
  return [{ type: "text", to, body: result.ok ? REJECTED_REPLY : PROPOSAL_GONE_REPLY }];
}

async function chooseTap(owner: VerifiedOwner, actor: CopilotActor, parts: string[], to: string): Promise<OutboundMessage[]> {
  const [conversationId, messageId, listingId] = parts;
  if (!conversationId || !messageId || !listingId) return [{ type: "text", to, body: PROPOSAL_GONE_REPLY }];
  const result = await chooseListing(owner.storeId, actor, { conversationId, messageId, listingId });
  if (!result.ok) {
    const body = result.code === "not_found" ? PROPOSAL_GONE_REPLY : "That choice is no longer open. Send the report again.";
    return [{ type: "text", to, body }];
  }
  return [proposalMessage(to, result.proposal)];
}

/**
 * A verified owner's message on the platform number (#144) runs the Store
 * copilot for their own store only: text is the web copilot's turn (the same
 * listing match, proposals, audit rows, spend cap and 30 sends an hour), and
 * each proposal comes back with Confirm and Reject buttons. A tap runs the same
 * confirm or reject as the copilot page, scoped to the owner's store, so an id
 * from another store finds nothing. Voice notes and photos ask for text.
 * Returns the replies in order; the caller sends them.
 */
export async function ownerCopilotReplies(owner: VerifiedOwner, message: InboundMessage, to: string): Promise<OutboundMessage[]> {
  const actor: CopilotActor = { id: owner.userId, email: owner.email };
  if (message.type === "interactive") {
    const [action, ...rest] = (message.replyId ?? "").split(":");
    if (action === CONFIRM && rest.length === 1) return confirmTap(owner, actor, rest[0]!, to);
    if (action === REJECT && rest.length === 1) return rejectTap(owner, actor, rest[0]!, to);
    if (action === CHOOSE && rest.length === 3) return chooseTap(owner, actor, rest, to);
    return [{ type: "text", to, body: PROPOSAL_GONE_REPLY }];
  }
  if (MEDIA.has(message.type)) return [{ type: "text", to, body: TYPE_YOUR_REPORT_REPLY }];
  const text = message.type === "text" ? (message.text ?? "").trim() : "";
  if (!text) return [];
  try {
    return await reportTurn(owner, message, text, to);
  } catch (error) {
    console.error(JSON.stringify({ event: "whatsapp_owner_turn_failed", storeId: owner.storeId, error: error instanceof Error ? error.name : "unknown" }));
    return [{ type: "text", to, body: FIXED_ERROR }];
  }
}
