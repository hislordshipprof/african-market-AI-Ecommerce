import { APICallError, generateText, stepCountIs } from "ai";
import { Prisma } from "@prisma/client";
import {
  assistantModelId,
  assistantProviderOptions,
  createAssistantModel,
} from "../assistant/model";
import { AssistantConfigError } from "../assistant/errors";
import { claimCapAlert, assistantSpendState, utcDay } from "../assistant/spend";
import { lockStoreRow, Prisma as DbPrisma, storeScoped, storeScopedRawQuery, storeScopedTransaction, txExecute, txQuery } from "../db";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { cardFromParts, loadProposalCards } from "./cards";
import { modelHistory, parseStoredMessages, type StoredMessage } from "./messages";
import { COPILOT_SYSTEM_PROMPT } from "./prompt";
import { copilotTools, createDraftBook, type Draft } from "./tools";
import {
  CONVERSATION_MAX,
  FIXED_ERROR,
  HISTORY_MAX,
  HOUR_MS,
  MAX_OUTPUT_TOKENS,
  MESSAGE_MAX,
  MODEL_TIMEOUT_MS,
  RESTING_MESSAGE,
  SENDS_PER_HOUR,
  STEP_CAP,
  UNAVAILABLE_MESSAGE,
  WRITE_TRANSACTION,
  type SendResult,
} from "./types";

class TurnLost extends Error {
  constructor() {
    super("turn lost");
    this.name = "TurnLost";
  }
}

function logModelFailure(error: unknown): void {
  if (APICallError.isInstance(error)) {
    const headers = error.responseHeaders;
    const requestId = headers && typeof headers === "object"
      ? (headers as Record<string, string | undefined>)["request-id"]
      : undefined;
    console.error("[copilot] model call failed", {
      statusCode: error.statusCode,
      errorType: error.name,
      requestId,
    });
    return;
  }
  const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
  console.error("[copilot] model call failed", {
    errorType: error instanceof Error ? error.name : "Error",
    code,
  });
}

function isContention(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2028" || error.code === "P2034" || error.code === "P2002";
  }
  const message = error instanceof Error ? error.message : "";
  return message.includes("40P01") || message.includes("deadlock detected");
}

async function bestEffort(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error("[copilot] cleanup failed", { errorType: error instanceof Error ? error.name : "Error" });
  }
}

function configMissing(): boolean {
  try {
    assistantModelId();
  } catch {
    return true;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  return typeof key !== "string" || key.trim() === "";
}

async function readReplay(storeId: string, userId: string, messageId: string): Promise<SendResult | null> {
  const rows = await storeScopedRawQuery<{ reply: string | null; conversation_id: string | null }>(
    storeId,
    DbPrisma.sql`
      SELECT reply, conversation_id
      FROM copilot_client_messages
      WHERE store_id = ${storeId}
        AND user_id = ${userId}
        AND client_message_id = ${messageId}
        AND reply IS NOT NULL
    `,
  );
  const row = rows[0];
  if (!row?.reply || !row.conversation_id) return null;
  const proposals = await loadProposalCards(storeId, { messageId });
  return { ok: true, conversationId: row.conversation_id, reply: row.reply, proposals };
}

async function claimMessage(storeId: string, userId: string, messageId: string): Promise<"claimed" | "busy" | SendResult> {
  const inserted = await storeScopedTransaction(storeId, (tx) => txQuery<Array<{ id: string }>>(tx, DbPrisma.sql`
    INSERT INTO copilot_client_messages (
      id, store_id, user_id, client_message_id, claimed_until, created_at
    ) VALUES (
      ${crypto.randomUUID()}, ${storeId}, ${userId}, ${messageId},
      (clock_timestamp() AT TIME ZONE 'UTC') + interval '60 seconds',
      (clock_timestamp() AT TIME ZONE 'UTC')
    )
    ON CONFLICT (store_id, user_id, client_message_id) DO NOTHING
    RETURNING id
  `));
  if (inserted.length > 0) return "claimed";
  const stored = await readReplay(storeId, userId, messageId);
  if (stored) return stored;
  const taken = await storeScopedTransaction(storeId, (tx) => txQuery<Array<{ id: string }>>(tx, DbPrisma.sql`
    UPDATE copilot_client_messages
    SET claimed_until = (clock_timestamp() AT TIME ZONE 'UTC') + interval '60 seconds'
    WHERE store_id = ${storeId}
      AND user_id = ${userId}
      AND client_message_id = ${messageId}
      AND reply IS NULL
      AND claimed_until <= (clock_timestamp() AT TIME ZONE 'UTC')
    RETURNING id
  `));
  return taken.length > 0 ? "claimed" : "busy";
}

async function releaseClaim(storeId: string, userId: string, messageId: string): Promise<void> {
  await storeScopedTransaction(storeId, (tx) => txExecute(tx, DbPrisma.sql`
    DELETE FROM copilot_client_messages
    WHERE store_id = ${storeId}
      AND user_id = ${userId}
      AND client_message_id = ${messageId}
      AND reply IS NULL
  `));
}

async function insertConversation(storeId: string, userId: string, model: string, id: string): Promise<boolean> {
  const rows = await storeScopedTransaction(storeId, (tx) => txQuery<Array<{ id: string }>>(tx, DbPrisma.sql`
    INSERT INTO copilot_conversations (
      id, store_id, user_id, model, messages, created_at, last_message_at
    ) VALUES (
      ${id}, ${storeId}, ${userId}, ${model}, '[]'::jsonb,
      (clock_timestamp() AT TIME ZONE 'UTC'),
      (clock_timestamp() AT TIME ZONE 'UTC')
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `));
  return rows.length > 0;
}

async function ensureConversation(
  storeId: string,
  userId: string,
  model: string,
  requestedId: string | undefined,
): Promise<{ ok: true; id: string; created: boolean; messages: StoredMessage[] } | { ok: false; code: "not_found"; message: string }> {
  const fresh = async () => {
    const id = crypto.randomUUID();
    await insertConversation(storeId, userId, model, id);
    return { ok: true as const, id, created: true, messages: [] as StoredMessage[] };
  };
  if (!requestedId) return fresh();
  const created = await insertConversation(storeId, userId, model, requestedId);
  const row = await storeScoped(storeId).copilotConversation.findUnique({ where: { id: requestedId } });
  if (!row || row.userId !== userId) return { ok: false, code: "not_found", message: "That chat was not found." };
  const messages = parseStoredMessages(row.messages);
  if (messages.length >= CONVERSATION_MAX) return fresh();
  return { ok: true, id: row.id, created, messages };
}

async function takeLease(storeId: string, conversationId: string): Promise<string | null> {
  const rows = await storeScopedTransaction(storeId, (tx) => txQuery<Array<{ token: string }>>(tx, DbPrisma.sql`
    UPDATE copilot_conversations
    SET in_flight_until = (clock_timestamp() AT TIME ZONE 'UTC') + interval '60 seconds'
    WHERE id = ${conversationId}
      AND (in_flight_until IS NULL OR in_flight_until <= (clock_timestamp() AT TIME ZONE 'UTC'))
    RETURNING to_char(in_flight_until, 'YYYY-MM-DD HH24:MI:SS.MS') AS token
  `));
  return rows[0]?.token ?? null;
}

async function releaseLease(storeId: string, conversationId: string, token: string): Promise<void> {
  await storeScopedTransaction(storeId, (tx) => txExecute(tx, DbPrisma.sql`
    UPDATE copilot_conversations
    SET in_flight_until = NULL
    WHERE id = ${conversationId}
      AND to_char(in_flight_until, 'YYYY-MM-DD HH24:MI:SS.MS') = ${token}
  `));
}

async function deleteEmpty(storeId: string, conversationId: string): Promise<void> {
  await storeScopedTransaction(storeId, (tx) => txExecute(tx, DbPrisma.sql`
    DELETE FROM copilot_conversations
    WHERE id = ${conversationId} AND messages = '[]'::jsonb
  `));
}

function visibleReply(text: string, drafts: Draft[], capped: boolean): string {
  const trimmed = text.trim();
  if (trimmed) {
    if (capped && !trimmed.includes("Send the rest in a new message.")) {
      return `${trimmed}\n\nSend the rest in a new message.`.slice(0, 4000);
    }
    return trimmed.slice(0, 4000);
  }
  if (drafts.length === 0) {
    return "I didn't catch a stock change. Name the item and a whole number, or open Products.";
  }
  const names = drafts.map((draft) => draft.listingName).join(", ");
  const noun = drafts.length === 1 ? "a change" : "changes";
  return `I drafted ${noun} for ${names}. Send the rest in a new message.`;
}

export async function sendCopilotTurn(input: {
  storeId: string;
  userId: string;
  email: string;
  conversationId?: string;
  messageId: string;
  text: string;
}): Promise<SendResult> {
  const text = input.text.trim();
  if (!text || input.text.trim().length > MESSAGE_MAX) {
    return { ok: false, code: "invalid_request", message: "Write a stock report of 1,000 characters or less." };
  }
  const replay = await readReplay(input.storeId, input.userId, input.messageId);
  if (replay) return replay;
  if (configMissing()) return { ok: false, code: "copilot_unavailable", message: UNAVAILABLE_MESSAGE };

  try {
    const spend = await assistantSpendState();
    if (spend.resting) {
      await claimCapAlert(utcDay(new Date()));
      return { ok: false, code: "copilot_resting", message: RESTING_MESSAGE };
    }
  } catch {
    return { ok: false, code: "copilot_resting", message: RESTING_MESSAGE };
  }

  const limit = await takeRateLimit(`copilot:${input.storeId}:${input.userId}`, SENDS_PER_HOUR, HOUR_MS);
  if (!limit.ok) {
    return {
      ok: false,
      code: "rate_limited",
      message: `Wait ${limit.retryAfter} seconds, then send that again.`,
      retryAfter: limit.retryAfter,
    };
  }

  const claim = await claimMessage(input.storeId, input.userId, input.messageId);
  if (claim !== "claimed") {
    return claim === "busy"
      ? { ok: false, code: "busy", message: "The copilot is still working on your last message." }
      : claim;
  }

  let createdId: string | null = null;
  let lease: { id: string; token: string } | null = null;
  let committed = false;
  try {
    const modelId = assistantModelId();
    const conversation = await ensureConversation(input.storeId, input.userId, modelId, input.conversationId);
    if (!conversation.ok) return conversation;
    if (conversation.created) createdId = conversation.id;
    const token = await takeLease(input.storeId, conversation.id);
    if (!token) return { ok: false, code: "busy", message: "The copilot is still working on your last message." };
    lease = { id: conversation.id, token };

    const history = conversation.messages.slice(-HISTORY_MAX);
    const book = createDraftBook();
    const result = await generateText({
      model: createAssistantModel(),
      system: COPILOT_SYSTEM_PROMPT,
      messages: [...modelHistory(history), { role: "user", content: text }],
      tools: copilotTools(input.storeId, book),
      stopWhen: stepCountIs(STEP_CAP),
      maxRetries: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeout: { totalMs: MODEL_TIMEOUT_MS },
      providerOptions: assistantProviderOptions(modelId),
    });
    const steps = Array.isArray(result.steps) ? result.steps.length : 0;
    const capped = steps >= STEP_CAP || result.finishReason === "length" || book.overflow;
    const reply = visibleReply(result.text, book.drafts, capped);
    const summary = book.drafts.length
      ? `Drafted: ${book.drafts.map((draft) => `${draft.listingName} ${draft.kind} ${draft.quantity ?? draft.statusValue}`).join("; ")}.`
      : undefined;
    const stored = await commitTurn({
      storeId: input.storeId,
      userId: input.userId,
      email: input.email,
      conversationId: conversation.id,
      token,
      messageId: input.messageId,
      text,
      reply,
      summary,
      existing: conversation.messages,
      drafts: book.drafts,
    });
    committed = true;
    return stored;
  } catch (error) {
    if (error instanceof AssistantConfigError) {
      return { ok: false, code: "copilot_unavailable", message: UNAVAILABLE_MESSAGE };
    }
    if (!(error instanceof TurnLost) && !isContention(error)) logModelFailure(error);
    else logModelFailure(error);
    const stored = await readReplay(input.storeId, input.userId, input.messageId);
    if (stored) return stored;
    return { ok: false, code: "copilot_unavailable", message: FIXED_ERROR };
  } finally {
    if (!committed) {
      const held = lease;
      const created = createdId;
      await bestEffort(() => releaseClaim(input.storeId, input.userId, input.messageId));
      if (held) await bestEffort(() => releaseLease(input.storeId, held.id, held.token));
      if (created) await bestEffort(() => deleteEmpty(input.storeId, created));
    }
  }
}

async function commitTurn(input: {
  storeId: string;
  userId: string;
  email: string;
  conversationId: string;
  token: string;
  messageId: string;
  text: string;
  reply: string;
  summary?: string;
  existing: StoredMessage[];
  drafts: Draft[];
}): Promise<SendResult> {
  const proposals = input.drafts.map((draft) => ({
    id: crypto.randomUUID(),
    draft,
    card: cardFromParts({
      id: "",
      listingId: draft.listingId,
      listingName: draft.listingName,
      kind: draft.kind,
      quantity: draft.quantity,
      statusValue: draft.statusValue,
      before: { qty: draft.beforeQty, status: draft.beforeStatus },
      state: "pending",
    }),
  }));
  for (const proposal of proposals) proposal.card.id = proposal.id;

  const nextMessages: StoredMessage[] = [
    ...input.existing,
    { role: "owner", text: input.text },
    { role: "assistant", text: input.reply, ...(input.summary ? { summary: input.summary } : {}) },
  ];

  await storeScopedTransaction(input.storeId, async (tx) => {
    await lockStoreRow(tx, input.storeId);
    const held = await txQuery<Array<{ id: string }>>(tx, DbPrisma.sql`
      SELECT id FROM copilot_conversations
      WHERE id = ${input.conversationId}
        AND to_char(in_flight_until, 'YYYY-MM-DD HH24:MI:SS.MS') = ${input.token}
      FOR UPDATE
    `);
    if (held.length === 0) throw new TurnLost();

    if (proposals.length > 0) {
      await txExecute(tx, DbPrisma.sql`
        UPDATE stock_proposals
        SET state = 'expired'
        WHERE store_id = ${input.storeId}
          AND state = 'pending'
          AND listing_id IN (${DbPrisma.join(proposals.map((proposal) => proposal.draft.listingId))})
      `);
    }
    for (const proposal of proposals) {
      const before = JSON.stringify({ qty: proposal.draft.beforeQty, status: proposal.draft.beforeStatus });
      await txExecute(tx, DbPrisma.sql`
        INSERT INTO stock_proposals (
          id, store_id, conversation_id, listing_id, client_message_id,
          kind, quantity, status_value, before, state, expires_at, created_at
        ) VALUES (
          ${proposal.id}, ${input.storeId}, ${input.conversationId}, ${proposal.draft.listingId}, ${input.messageId},
          ${proposal.draft.kind}, ${proposal.draft.quantity}, ${proposal.draft.statusValue}, ${before}::jsonb,
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
          entityId: proposal.id,
          after: {
            kind: proposal.draft.kind,
            quantity: proposal.draft.quantity,
            status: proposal.draft.statusValue,
          },
        },
      });
    }
    await txExecute(tx, DbPrisma.sql`
      UPDATE copilot_conversations
      SET messages = ${JSON.stringify(nextMessages)}::jsonb,
          last_message_at = (clock_timestamp() AT TIME ZONE 'UTC'),
          in_flight_until = NULL
      WHERE id = ${input.conversationId}
    `);
    const receipt = await txExecute(tx, DbPrisma.sql`
      UPDATE copilot_client_messages
      SET reply = ${input.reply}, conversation_id = ${input.conversationId}
      WHERE store_id = ${input.storeId}
        AND user_id = ${input.userId}
        AND client_message_id = ${input.messageId}
        AND reply IS NULL
    `);
    if (receipt === 0) throw new TurnLost();
  }, WRITE_TRANSACTION);

  return {
    ok: true,
    conversationId: input.conversationId,
    reply: input.reply,
    proposals: proposals.map((proposal) => proposal.card),
  };
}

export async function loadCopilotPanel(storeId: string, userId: string): Promise<{
  conversationId: string | null;
  messages: StoredMessage[];
  proposals: Awaited<ReturnType<typeof loadProposalCards>>;
}> {
  const conversation = await storeScoped(storeId).copilotConversation.findFirst({
    where: { userId },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
  });
  if (!conversation) return { conversationId: null, messages: [], proposals: [] };
  const proposals = await loadProposalCards(storeId, { conversationId: conversation.id });
  return {
    conversationId: conversation.id,
    messages: parseStoredMessages(conversation.messages),
    proposals,
  };
}
