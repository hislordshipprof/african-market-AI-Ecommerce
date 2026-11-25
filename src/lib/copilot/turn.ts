import { APICallError, generateText, stepCountIs } from "ai";
import { Prisma } from "@prisma/client";
import {
  assistantModelId,
  assistantProviderOptions,
  createAssistantModel,
} from "../assistant/model";
import { callCostMicros, tokenUsageOf } from "../assistant/cost";
import { AssistantConfigError } from "../assistant/errors";
import { claimCapAlert, assistantSpendState, utcDay } from "../assistant/spend";
import {
  deleteEmptyCopilotConversation,
  insertCopilotClientMessage,
  insertCopilotConversation,
  lockCopilotLease,
  lockStoreRow,
  Prisma as DbPrisma,
  recordCopilotReply,
  releaseCopilotClientMessage,
  releaseCopilotLease,
  retakeCopilotClientMessage,
  saveCopilotTurn,
  storeScoped,
  storeScopedRawQuery,
  storeScopedTransaction,
  takeCopilotLease,
} from "../db";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { storeMayUse } from "../billing/plan";
import { loadProposalCards } from "./cards";
import { choiceCards } from "./choices";
import { modelHistory, parseStoredMessages, type StoredMessage } from "./messages";
import { COPILOT_SYSTEM_PROMPT, NO_DRAFTS_HERE } from "./prompt";
import { databaseClock, insertProposalRows } from "./proposals";
import { insertDraftRows, loadDraftCards, type DraftMakers, type PendingDraft } from "./draft-rows";
import { copilotTools, createDraftBook, type DraftBook, type Draft, type PendingChoice } from "./tools";
import { estimateText, storeTimeZone } from "./inventory-report";
import { storeToday } from "../analytics/range";
import { salesText, type PayoutReader } from "./sales-summary";
import {
  CONVERSATION_MAX,
  FIXED_ERROR,
  HISTORY_MAX,
  HOUR_MS,
  MAX_OUTPUT_TOKENS,
  MESSAGE_MAX,
  MODEL_TIMEOUT_MS,
  PROPOSAL_MAX,
  RESTING_MESSAGE,
  SENDS_PER_HOUR,
  STEP_CAP,
  UNAVAILABLE_MESSAGE,
  WRITE_TRANSACTION,
  type ChoiceCard,
  type DraftCard,
  type ListingChoice,
  type PanelMessage,
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

export function configMissing(): boolean {
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
  const choices = await turnChoices(storeId, row.conversation_id, messageId);
  const drafts = await loadDraftCards(storeId, { messageId });
  return { ok: true, conversationId: row.conversation_id, reply: row.reply, proposals, choices, drafts };
}

async function turnChoices(storeId: string, conversationId: string, messageId: string): Promise<ChoiceCard[]> {
  const conversation = await storeScoped(storeId).copilotConversation.findUnique({
    where: { id: conversationId },
    select: { messages: true },
  });
  const turn = parseStoredMessages(conversation?.messages).filter((message) => (
    message.role === "assistant" && message.messageId === messageId
  ));
  const [cards] = await choiceCards(storeId, conversationId, turn);
  return cards?.choices ?? [];
}

async function claimMessage(storeId: string, userId: string, messageId: string): Promise<"claimed" | "busy" | SendResult> {
  const inserted = await storeScopedTransaction(storeId, (tx) => insertCopilotClientMessage(tx, storeId, userId, messageId));
  if (inserted) return "claimed";
  const stored = await readReplay(storeId, userId, messageId);
  if (stored) return stored;
  const taken = await storeScopedTransaction(storeId, (tx) => retakeCopilotClientMessage(tx, storeId, userId, messageId));
  return taken ? "claimed" : "busy";
}

async function releaseClaim(storeId: string, userId: string, messageId: string): Promise<void> {
  await storeScopedTransaction(storeId, (tx) => releaseCopilotClientMessage(tx, storeId, userId, messageId));
}

async function insertConversation(storeId: string, userId: string, model: string, id: string): Promise<boolean> {
  return storeScopedTransaction(storeId, (tx) => insertCopilotConversation(tx, { id, storeId, userId, model }));
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
  return storeScopedTransaction(storeId, (tx) => takeCopilotLease(tx, conversationId));
}

async function releaseLease(storeId: string, conversationId: string, token: string): Promise<void> {
  await storeScopedTransaction(storeId, (tx) => releaseCopilotLease(tx, conversationId, token));
}

async function deleteEmpty(storeId: string, conversationId: string): Promise<void> {
  await storeScopedTransaction(storeId, (tx) => deleteEmptyCopilotConversation(tx, conversationId));
}

/** A Starter store, or a Pro store that dropped to Starter, keeps its chat history but cannot send (#818). */
export const PLAN_LOCKED_MESSAGE = "Store assistant (AI chat) is on the Pro plan. Upgrade on the Plan page to send messages.";

export const NOTHING_DRAFTED = "Nothing was drafted.";
export const DRAFT_REPLY = "I drafted this for you to check below. Nothing changes until you confirm.";
export const NUMBER_REFUSED =
  "I can only give numbers from your stock records, and that answer had one I could not check. See Stock movement on this page.";

const NUMBER = /\d+(?:[.,]\d+)*/g;
const REPLY_ROWS = 5;

function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((token) => String(Number(token.replace(/,(?=\d{3}\b)/g, ""))));
}

/**
 * The reply may quote only numbers from the owner's message or this turn's tool results. Any other
 * number swaps the model's text for a fixed summary of the report rows, or a refusal.
 */
export function checkedText(text: string, ownerText: string, book: DraftBook): string {
  const allowed = new Set([ownerText, ...book.toolResults, String(PROPOSAL_MAX)].flatMap(numbersIn));
  if (numbersIn(text).every((n) => allowed.has(n))) return text;
  if (book.copilotDrafts.length > 0) return DRAFT_REPLY;
  if (book.sales.length > 0) return book.sales.map(salesText).join("\n");
  const rows = [...new Map(book.report.map((row) => [row.listingId, row])).values()].slice(0, REPLY_ROWS);
  if (rows.length === 0) return NUMBER_REFUSED;
  return rows.map((row) => (
    `${row.name}: ${row.online7} sold online this week (${row.onlinePrior7} the week before), `
    + `${row.counter7} counter sales reported. ${estimateText(row.estimate)}.`
  )).join("\n");
}

/** The model's text, plus fixed lines chosen from what the turn produced. The model's text is never inspected. */
function visibleReply(text: string, drafts: Draft[], choices: PendingChoice[], capped: boolean, answered: boolean): string {
  const parts: string[] = [];
  const trimmed = text.trim().slice(0, 4000);
  if (trimmed) {
    parts.push(trimmed);
  } else if (drafts.length > 0) {
    const names = drafts.map((draft) => draft.listingName).join(", ");
    parts.push(`I drafted ${drafts.length === 1 ? "a change" : "changes"} for ${names}.`);
  } else if (choices.length > 0) {
    parts.push("More than one item matches. Pick one below.");
  }
  if (capped) parts.push("Send the rest in a new message.");
  if (drafts.length === 0 && choices.length === 0 && !answered) parts.push(NOTHING_DRAFTED);
  return parts.join("\n\n");
}

export interface GateRefusal {
  ok: false;
  code: "copilot_unavailable" | "copilot_resting" | "rate_limited";
  message: string;
  retryAfter?: number;
}

/** Before any model call: the model is configured, the platform spend cap is not reached, and `rateKey` has sends left this hour. */
export async function copilotGate(rateKey: string, perHour = SENDS_PER_HOUR): Promise<GateRefusal | null> {
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
  const limit = await takeRateLimit(rateKey, perHour, HOUR_MS);
  if (!limit.ok) {
    return {
      ok: false,
      code: "rate_limited",
      message: `Wait ${limit.retryAfter} seconds, then send that again.`,
      retryAfter: limit.retryAfter,
    };
  }
  return null;
}

export async function sendCopilotTurn(input: {
  storeId: string;
  userId: string;
  email: string;
  conversationId?: string;
  messageId: string;
  text: string;
  /** The store admin page's payout reader; without it a sales answer says the payout is not known. */
  payouts?: PayoutReader;
  /** The page's coupon, price and store-change draft makers (#819); WhatsApp shows no cards, so it passes none. */
  drafts?: DraftMakers;
}): Promise<SendResult> {
  const text = input.text.trim();
  if (!text || input.text.trim().length > MESSAGE_MAX) {
    return { ok: false, code: "invalid_request", message: "Write a message of 1,000 characters or less." };
  }
  const replay = await readReplay(input.storeId, input.userId, input.messageId);
  if (replay) return replay;
  if (!(await storeMayUse(input.storeId, "store-assistant"))) {
    return { ok: false, code: "plan_locked", message: PLAN_LOCKED_MESSAGE };
  }
  const refused = await copilotGate(`copilot:${input.storeId}:${input.userId}`);
  if (refused) return refused;

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
    const timeZone = await storeTimeZone(input.storeId);
    const today = storeToday(timeZone);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(new Date());
    const book = createDraftBook();
    const result = await generateText({
      model: createAssistantModel(),
      // Without today's date the model guesses the year of "Nov 2 to Nov 8".
      system: `${COPILOT_SYSTEM_PROMPT}${input.drafts ? "" : `\n\n${NO_DRAFTS_HERE}`}\n\nToday is ${today}, a ${weekday}, in the store's time zone (${timeZone}).`,
      messages: [...modelHistory(history), { role: "user", content: text }],
      tools: copilotTools(input.storeId, book, {
        payouts: input.payouts ?? null,
        ...(input.drafts ? { drafts: { ownerText: text, make: input.drafts } } : {}),
      }),
      stopWhen: stepCountIs(STEP_CAP),
      maxRetries: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeout: { totalMs: MODEL_TIMEOUT_MS },
      providerOptions: assistantProviderOptions(modelId),
    });
    const steps = Array.isArray(result.steps) ? result.steps.length : 0;
    const capped = (steps >= STEP_CAP && result.finishReason === "tool-calls") || result.finishReason === "length" || book.overflow;
    const answered = book.sales.length > 0 || book.copilotDrafts.length > 0;
    const reply = visibleReply(checkedText(result.text, text, book), book.drafts, book.choices, capped, answered);
    const usage = turnUsage(modelId, result.steps);
    const stored = await commitTurn({
      storeId: input.storeId,
      userId: input.userId,
      email: input.email,
      conversationId: conversation.id,
      token,
      messageId: input.messageId,
      text,
      reply,
      existing: conversation.messages,
      drafts: book.drafts,
      choices: book.choices,
      copilotDrafts: book.copilotDrafts,
      usage,
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

interface TurnUsage {
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
}

/** Tokens and cost of one turn's model steps. An unpriced model still saves the turn; the spend gate already failed closed. */
function turnUsage(modelId: string, steps: unknown): TurnUsage {
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = BigInt(0);
  for (const step of Array.isArray(steps) ? steps : []) {
    const usage = tokenUsageOf((step as { usage?: unknown } | null)?.usage);
    try {
      cost += callCostMicros(modelId, usage);
    } catch {
      // No price for this model.
    }
    tokensIn += Number(usage.inputTokens?.total ?? 0);
    tokensOut += Number(usage.outputTokens?.total ?? 0);
  }
  return { tokensIn, tokensOut, costMicros: Number(cost) };
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
  existing: StoredMessage[];
  drafts: Draft[];
  choices: PendingChoice[];
  copilotDrafts: PendingDraft[];
  usage: TurnUsage;
}): Promise<SendResult> {
  let proposals: Awaited<ReturnType<typeof insertProposalRows>> = [];
  let drafts: DraftCard[] = [];
  let choices: ListingChoice[] = [];

  await storeScopedTransaction(input.storeId, async (tx) => {
    await lockStoreRow(tx, input.storeId);
    if (!(await lockCopilotLease(tx, input.conversationId, input.token))) throw new TurnLost();

    const clock = await databaseClock(tx);
    choices = input.choices.map((choice) => ({ ...choice, createdAt: clock.now, expiresAt: clock.expires }));
    proposals = await insertProposalRows(tx, {
      storeId: input.storeId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      userId: input.userId,
      email: input.email,
    }, input.drafts);
    drafts = await insertDraftRows(tx, {
      storeId: input.storeId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      userId: input.userId,
      email: input.email,
    }, input.copilotDrafts);

    const nextMessages: StoredMessage[] = [
      ...input.existing,
      { role: "owner", text: input.text },
      {
        role: "assistant",
        text: input.reply,
        messageId: input.messageId,
        ...(choices.length > 0 ? { choices } : {}),
        costMicros: input.usage.costMicros,
      },
    ];
    await saveCopilotTurn(tx, {
      conversationId: input.conversationId,
      messages: nextMessages,
      tokensIn: input.usage.tokensIn,
      tokensOut: input.usage.tokensOut,
      costMicros: input.usage.costMicros,
    });
    const recorded = await recordCopilotReply(tx, {
      storeId: input.storeId,
      userId: input.userId,
      messageId: input.messageId,
      reply: input.reply,
      conversationId: input.conversationId,
    });
    if (!recorded) throw new TurnLost();
  }, WRITE_TRANSACTION);

  return {
    ok: true,
    conversationId: input.conversationId,
    reply: input.reply,
    proposals,
    choices: choices.map((choice) => ({ ...choice, chosenListingId: null, open: true })),
    drafts,
  };
}

export async function loadCopilotPanel(storeId: string, userId: string): Promise<{
  conversationId: string | null;
  messages: PanelMessage[];
  proposals: Awaited<ReturnType<typeof loadProposalCards>>;
  drafts: DraftCard[];
}> {
  const conversation = await storeScoped(storeId).copilotConversation.findFirst({
    where: { userId },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
  });
  if (!conversation) return { conversationId: null, messages: [], proposals: [], drafts: [] };
  const proposals = await loadProposalCards(storeId, { conversationId: conversation.id });
  const drafts = await loadDraftCards(storeId, { conversationId: conversation.id });
  return {
    conversationId: conversation.id,
    messages: await choiceCards(storeId, conversation.id, parseStoredMessages(conversation.messages)),
    proposals,
    drafts,
  };
}
