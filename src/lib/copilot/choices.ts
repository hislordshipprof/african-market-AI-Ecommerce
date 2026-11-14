import { Prisma, lockStoreRow, storeScoped, storeScopedRawQuery, storeScopedTransaction, txQuery } from "../db";
import { loadProposalCards } from "./cards";
import { parseStoredMessages, type StoredMessage } from "./messages";
import { databaseClock, insertProposalRows } from "./proposals";
import { DRAFT_LISTING_SELECT, DraftRefused, draftFor } from "./tools";
import {
  WRITE_TRANSACTION,
  type ChoiceCard,
  type ChooseResult,
  type CopilotActor,
  type ListingChoice,
  type PanelMessage,
} from "./types";

interface ChosenRow {
  client_message_id: string;
  listing_id: string;
}

function chosenFor(choice: ListingChoice, messageId: string | undefined, chosen: readonly ChosenRow[]): string | null {
  if (!messageId) return null;
  const ids = new Set(choice.candidates.map((candidate) => candidate.listingId));
  return chosen.find((row) => row.client_message_id === messageId && ids.has(row.listing_id))?.listing_id ?? null;
}

/** Adds what the owner already picked, and whether each choice is still open, by the database clock. */
export async function choiceCards(
  storeId: string,
  conversationId: string,
  messages: readonly StoredMessage[],
): Promise<PanelMessage[]> {
  if (!messages.some((message) => message.choices?.length)) {
    return messages.map((message) => ({ role: message.role, text: message.text, messageId: message.messageId }));
  }
  const [clock] = await storeScopedRawQuery<{ now: string }>(storeId, Prisma.sql`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
  `);
  const chosen = await storeScopedRawQuery<ChosenRow>(storeId, Prisma.sql`
    SELECT client_message_id, listing_id FROM stock_proposals WHERE conversation_id = ${conversationId}
  `);
  const now = clock?.now ?? "";
  return messages.map((message) => ({
    role: message.role,
    text: message.text,
    messageId: message.messageId,
    ...(message.choices?.length
      ? {
        choices: message.choices.map((choice): ChoiceCard => {
          const chosenListingId = chosenFor(choice, message.messageId, chosen);
          return { ...choice, chosenListingId, open: !chosenListingId && choice.expiresAt > now };
        }),
      }
      : {}),
  }));
}

type TxOutcome = ChooseResult | { ok: "existing"; proposalId: string };

/**
 * The owner taps one listing of a stored choice. Drafts the normal pending proposal, with no model call.
 * Lock order matches the turn commit: store row, then the conversation row.
 */
export async function chooseListing(
  storeId: string,
  actor: CopilotActor,
  input: { conversationId: string; messageId: string; listingId: string },
): Promise<ChooseResult> {
  const conversation = await storeScoped(storeId).copilotConversation.findUnique({
    where: { id: input.conversationId },
    select: { userId: true },
  });
  if (!conversation || conversation.userId !== actor.id) return { ok: false, code: "not_found" };

  const outcome = await storeScopedTransaction(storeId, async (tx): Promise<TxOutcome> => {
    await lockStoreRow(tx, storeId);
    const rows = await txQuery<Array<{ messages: unknown }>>(tx, Prisma.sql`
      SELECT messages FROM copilot_conversations
      WHERE id = ${input.conversationId} AND user_id = ${actor.id}
      FOR UPDATE
    `);
    if (!rows[0]) return { ok: false, code: "not_found" };
    const messages = parseStoredMessages(rows[0].messages);
    const index = messages.findIndex((message) => message.role === "assistant" && message.messageId === input.messageId);
    const choice = index < 0
      ? undefined
      : messages[index]!.choices?.find((item) => item.candidates.some((candidate) => candidate.listingId === input.listingId));
    if (!choice) return { ok: false, code: "not_found" };

    const candidateIds = choice.candidates.map((candidate) => candidate.listingId);
    const existing = await txQuery<Array<{ id: string; listing_id: string }>>(tx, Prisma.sql`
      SELECT id, listing_id FROM stock_proposals
      WHERE conversation_id = ${input.conversationId}
        AND client_message_id = ${input.messageId}
        AND listing_id IN (${Prisma.join(candidateIds)})
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `);
    if (existing[0]) {
      return existing[0].listing_id === input.listingId
        ? { ok: "existing", proposalId: existing[0].id }
        : { ok: false, code: "not_found" };
    }

    const clock = await databaseClock(tx);
    if (choice.expiresAt <= clock.now) return { ok: false, code: "expired" };

    const offeredLater = messages.slice(index + 1).some((message) => message.choices?.some((item) => (
      item.candidates.some((candidate) => candidate.listingId === input.listingId)
    )));
    if (offeredLater) return { ok: false, code: "stale" };
    const newer = await txQuery<Array<{ id: string }>>(tx, Prisma.sql`
      SELECT id FROM stock_proposals
      WHERE listing_id = ${input.listingId}
        AND created_at > CAST(${choice.createdAt} AS timestamp(3))
      LIMIT 1
    `);
    if (newer.length > 0) return { ok: false, code: "stale" };

    const listing = await tx.listing.findUnique({ where: { id: input.listingId }, select: DRAFT_LISTING_SELECT });
    let draft;
    try {
      draft = draftFor(listing, choice);
    } catch (error) {
      if (error instanceof DraftRefused) return { ok: false, code: "stale" };
      throw error;
    }
    const [card] = await insertProposalRows(tx, {
      storeId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      userId: actor.id,
      email: actor.email,
    }, [draft]);
    return { ok: true, proposal: card! };
  }, WRITE_TRANSACTION);

  if (outcome.ok !== "existing") return outcome;
  const cards = await loadProposalCards(storeId, { messageId: input.messageId });
  const card = cards.find((item) => item.id === outcome.proposalId);
  return card ? { ok: true, proposal: card } : { ok: false, code: "not_found" };
}
