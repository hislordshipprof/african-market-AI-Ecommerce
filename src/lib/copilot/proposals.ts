import { Prisma, txExecute, txQuery, type storeScopedTransaction } from "../db";
import { cardFromParts } from "./cards";
import type { Draft } from "./tools";
import type { StockProposalCard } from "./types";

type Tx = Parameters<Parameters<typeof storeScopedTransaction>[1]>[0];

/** Fixed-width UTC text, so two values compare as strings in the same order as the times. */
const CLOCK_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;

/** The database clock now and 60 minutes from now, the proposal expiry. */
export async function databaseClock(tx: Tx): Promise<{ now: string; expires: string }> {
  const rows = await txQuery<Array<{ now: string; expires: string }>>(tx, Prisma.sql`
    SELECT to_char(t, ${CLOCK_FORMAT}) AS now,
      to_char(t + interval '60 minutes', ${CLOCK_FORMAT}) AS expires
    FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS t) clock
  `);
  return rows[0]!;
}

/**
 * Stores drafts as pending proposals with one `copilot.stock_proposed` audit row each.
 * An older pending proposal on the same listing becomes expired. The caller holds the store lock.
 */
export async function insertProposalRows(
  tx: Tx,
  input: { storeId: string; conversationId: string; messageId: string; userId: string; email: string },
  drafts: readonly Draft[],
): Promise<StockProposalCard[]> {
  if (drafts.length === 0) return [];
  await txExecute(tx, Prisma.sql`
    UPDATE stock_proposals
    SET state = 'expired'
    WHERE store_id = ${input.storeId}
      AND state = 'pending'
      AND listing_id IN (${Prisma.join(drafts.map((draft) => draft.listingId))})
  `);
  const cards: StockProposalCard[] = [];
  for (const draft of drafts) {
    const id = crypto.randomUUID();
    const before = { qty: draft.beforeQty, status: draft.beforeStatus };
    await txExecute(tx, Prisma.sql`
      INSERT INTO stock_proposals (
        id, store_id, conversation_id, listing_id, client_message_id,
        kind, quantity, status_value, before, state, expires_at, created_at
      ) VALUES (
        ${id}, ${input.storeId}, ${input.conversationId}, ${draft.listingId}, ${input.messageId},
        ${draft.kind}, ${draft.quantity}, ${draft.statusValue}, ${JSON.stringify(before)}::jsonb,
        'pending',
        (clock_timestamp() AT TIME ZONE 'UTC') + interval '60 minutes',
        (clock_timestamp() AT TIME ZONE 'UTC')
      )
    `);
    await tx.auditLog.create({
      data: {
        storeId: input.storeId,
        actorId: input.userId,
        actorEmail: input.email,
        action: "copilot.stock_proposed",
        entityType: "stock_proposal",
        entityId: id,
        after: { kind: draft.kind, quantity: draft.quantity, status: draft.statusValue },
      },
    });
    cards.push(cardFromParts({
      id,
      listingId: draft.listingId,
      listingName: draft.listingName,
      kind: draft.kind,
      quantity: draft.quantity,
      statusValue: draft.statusValue,
      before,
      state: "pending",
    }));
  }
  return cards;
}
