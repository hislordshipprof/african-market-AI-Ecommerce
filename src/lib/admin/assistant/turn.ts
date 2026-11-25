import { generateText, stepCountIs } from "ai";
import { assistantModelId, assistantProviderOptions, createAssistantModel } from "../../assistant/model";
import { AssistantConfigError } from "../../assistant/errors";
import {
  deleteEmptyAdminAssistantConversation,
  insertAdminAssistantClientMessage,
  insertAdminAssistantConversation,
  lockAdminAssistantLease,
  platformAdminTransaction,
  recordAdminAssistantReply,
  releaseAdminAssistantClientMessage,
  releaseAdminAssistantLease,
  retakeAdminAssistantClientMessage,
  saveAdminAssistantTurn,
  takeAdminAssistantLease,
} from "../../db";
import { bestEffort, copilotGate, logModelFailure, numbersIn, turnUsage } from "../../copilot/turn";
import {
  CONVERSATION_MAX,
  FIXED_ERROR,
  HISTORY_MAX,
  MAX_OUTPUT_TOKENS,
  MESSAGE_MAX,
  MODEL_TIMEOUT_MS,
  STEP_CAP,
  UNAVAILABLE_MESSAGE,
  WRITE_TRANSACTION,
} from "../../copilot/types";
import { ADMIN_ASSISTANT_PROMPT } from "./prompt";
import { adminAssistantTools, createReadBook, type ReadBook } from "./tools";
import { cardOf, insertAdminDrafts, loadAdminDraftCards, type AdminDraftCard } from "./drafts";
import { LINKS_MAX, type AdminAssistantMessage, type AdminAssistantResult, type AssistantLink } from "./types";

export const NUMBER_REFUSED =
  "I can only give numbers the platform's records returned, and that answer had one I could not check. Ask again, or open the screen below.";
const BUSY = "The assistant is still working on your last message.";

class TurnLost extends Error {}

interface Actor {
  id: string;
  email: string;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Only links to admin screens survive a round trip through the stored chat. */
function parseLinks(value: unknown): AssistantLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const label = str((item as { label?: unknown } | null)?.label);
    const href = str((item as { href?: unknown } | null)?.href);
    return label && href && /^\/admin(\/|\?|$)/.test(href) && !href.startsWith("//") ? [{ label, href }] : [];
  });
}

export function parseAdminMessages(value: unknown): AdminAssistantMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AdminAssistantMessage[] => {
    const role = (item as { role?: unknown } | null)?.role;
    const text = (item as { text?: unknown } | null)?.text;
    if ((role !== "admin" && role !== "assistant") || typeof text !== "string") return [];
    const messageId = str((item as { messageId?: unknown }).messageId);
    const links = parseLinks((item as { links?: unknown }).links);
    const costMicros = (item as { costMicros?: unknown }).costMicros;
    return [{
      role,
      text,
      ...(messageId ? { messageId } : {}),
      ...(links.length > 0 ? { links } : {}),
      ...(typeof costMicros === "number" && Number.isFinite(costMicros) ? { costMicros } : {}),
    }];
  });
}

/** The last stored turns, starting at an admin message so a pair is never split. */
function modelHistory(messages: AdminAssistantMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const recent = messages.slice(-HISTORY_MAX);
  const start = recent.findIndex((message) => message.role === "admin");
  if (start < 0) return [];
  return recent.slice(start).map((message) => ({ role: message.role === "admin" ? "user" : "assistant", content: message.text }));
}

/** The copilot's number check: the reply may quote only numbers from the admin's message or this turn's tool results. */
export function checkedReply(text: string, adminText: string, book: ReadBook): string {
  const allowed = new Set([adminText, ...book.toolResults].flatMap(numbersIn));
  return numbersIn(text).every((n) => allowed.has(n)) ? text : NUMBER_REFUSED;
}

async function readReplay(userId: string, messageId: string): Promise<AdminAssistantResult | null> {
  return platformAdminTransaction(async (tx) => {
    const receipt = await tx.adminAssistantClientMessage.findUnique({
      where: { userId_clientMessageId: { userId, clientMessageId: messageId } },
      select: { reply: true, conversationId: true },
    });
    if (!receipt?.reply || !receipt.conversationId) return null;
    const conversation = await tx.adminAssistantConversation.findUnique({ where: { id: receipt.conversationId }, select: { messages: true } });
    const turn = parseAdminMessages(conversation?.messages).find((message) => message.role === "assistant" && message.messageId === messageId);
    const drafts = await tx.adminAssistantDraft.findMany({
      where: { userId, conversationId: receipt.conversationId, clientMessageId: messageId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return { ok: true, conversationId: receipt.conversationId, reply: receipt.reply, links: turn?.links ?? [], drafts: drafts.map((row) => cardOf(row)) };
  });
}

async function claimMessage(userId: string, messageId: string): Promise<"claimed" | "busy" | AdminAssistantResult> {
  if (await platformAdminTransaction((tx) => insertAdminAssistantClientMessage(tx, userId, messageId))) return "claimed";
  const stored = await readReplay(userId, messageId);
  if (stored) return stored;
  return (await platformAdminTransaction((tx) => retakeAdminAssistantClientMessage(tx, userId, messageId))) ? "claimed" : "busy";
}

async function ensureConversation(userId: string, model: string, requestedId: string | undefined): Promise<
  { ok: true; id: string; created: boolean; messages: AdminAssistantMessage[] } | { ok: false; code: "not_found"; message: string }
> {
  const fresh = async () => {
    const id = crypto.randomUUID();
    await platformAdminTransaction((tx) => insertAdminAssistantConversation(tx, { id, userId, model }));
    return { ok: true as const, id, created: true, messages: [] as AdminAssistantMessage[] };
  };
  if (!requestedId) return fresh();
  const created = await platformAdminTransaction((tx) => insertAdminAssistantConversation(tx, { id: requestedId, userId, model }));
  const row = await platformAdminTransaction((tx) => tx.adminAssistantConversation.findUnique({ where: { id: requestedId } }));
  if (!row || row.userId !== userId) return { ok: false, code: "not_found", message: "That chat was not found." };
  const messages = parseAdminMessages(row.messages);
  if (messages.length >= CONVERSATION_MAX) return fresh();
  return { ok: true, id: row.id, created, messages };
}

/**
 * One admin turn, on the store copilot's engine: the same spend gate, hourly send limit, message claim, 60-second
 * lease, history and step caps. The caller has checked the platform admin session.
 */
export async function sendAdminAssistantTurn(input: {
  actor: Actor;
  conversationId?: string;
  messageId: string;
  text: string;
  now?: Date;
}): Promise<AdminAssistantResult> {
  const text = input.text.trim();
  if (!text || text.length > MESSAGE_MAX) {
    return { ok: false, code: "invalid_request", message: "Write a message of 1,000 characters or less." };
  }
  const { actor } = input;
  const replay = await readReplay(actor.id, input.messageId);
  if (replay) return replay;
  const refused = await copilotGate(`admin-assistant:${actor.id}`);
  if (refused) return refused;

  const claim = await claimMessage(actor.id, input.messageId);
  if (claim !== "claimed") return claim === "busy" ? { ok: false, code: "busy", message: BUSY } : claim;

  let createdId: string | null = null;
  let lease: { id: string; token: string } | null = null;
  let committed = false;
  try {
    const modelId = assistantModelId();
    const conversation = await ensureConversation(actor.id, modelId, input.conversationId);
    if (!conversation.ok) return conversation;
    if (conversation.created) createdId = conversation.id;
    const token = await platformAdminTransaction((tx) => takeAdminAssistantLease(tx, conversation.id));
    if (!token) return { ok: false, code: "busy", message: BUSY };
    lease = { id: conversation.id, token };

    const now = input.now ?? new Date();
    const book = createReadBook();
    const result = await generateText({
      model: createAssistantModel(),
      system: `${ADMIN_ASSISTANT_PROMPT}\n\nToday is ${now.toISOString().slice(0, 10)} (UTC).`,
      messages: [...modelHistory(conversation.messages), { role: "user", content: text }],
      tools: adminAssistantTools({ actor, conversationId: conversation.id, book, now }),
      stopWhen: stepCountIs(STEP_CAP),
      maxRetries: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeout: { totalMs: MODEL_TIMEOUT_MS },
      providerOptions: assistantProviderOptions(modelId),
    });
    const steps = Array.isArray(result.steps) ? result.steps.length : 0;
    const capped = (steps >= STEP_CAP && result.finishReason === "tool-calls") || result.finishReason === "length";
    const answer = result.text.trim().slice(0, 4000) || "I could not answer that from the platform's records.";
    const reply = [checkedReply(answer, text, book), ...(capped ? ["Ask the rest in a new message."] : [])].join("\n\n");
    const links = book.links.slice(0, LINKS_MAX);
    const usage = turnUsage(modelId, result.steps);

    const drafts = await platformAdminTransaction(async (tx) => {
      if (!(await lockAdminAssistantLease(tx, conversation.id, token))) throw new TurnLost();
      const messages: AdminAssistantMessage[] = [
        ...conversation.messages,
        { role: "admin", text },
        { role: "assistant", text: reply, messageId: input.messageId, ...(links.length > 0 ? { links } : {}), costMicros: usage.costMicros },
      ];
      await saveAdminAssistantTurn(tx, { conversationId: conversation.id, messages, ...usage });
      const recorded = await recordAdminAssistantReply(tx, { userId: actor.id, messageId: input.messageId, reply, conversationId: conversation.id });
      if (!recorded) throw new TurnLost();
      return insertAdminDrafts(tx, { userId: actor.id, email: actor.email, conversationId: conversation.id, messageId: input.messageId }, book.drafts);
    }, WRITE_TRANSACTION);
    committed = true;
    return { ok: true, conversationId: conversation.id, reply, links, drafts };
  } catch (error) {
    if (error instanceof AssistantConfigError) return { ok: false, code: "copilot_unavailable", message: UNAVAILABLE_MESSAGE };
    logModelFailure(error);
    const stored = await readReplay(actor.id, input.messageId);
    if (stored) return stored;
    return { ok: false, code: "copilot_unavailable", message: FIXED_ERROR };
  } finally {
    if (!committed) {
      const held = lease;
      const created = createdId;
      await bestEffort(() => platformAdminTransaction((tx) => releaseAdminAssistantClientMessage(tx, actor.id, input.messageId)));
      if (held) await bestEffort(() => platformAdminTransaction((tx) => releaseAdminAssistantLease(tx, held.id, held.token)));
      if (created) await bestEffort(() => platformAdminTransaction((tx) => deleteEmptyAdminAssistantConversation(tx, created)));
    }
  }
}

/** The admin's latest chat, for the page, with each turn's draft cards. */
export async function loadAdminAssistantChat(userId: string): Promise<{
  conversationId: string | null;
  messages: AdminAssistantMessage[];
  drafts: Record<string, AdminDraftCard[]>;
}> {
  const conversation = await platformAdminTransaction((tx) => tx.adminAssistantConversation.findFirst({
    where: { userId },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    select: { id: true, messages: true },
  }));
  if (!conversation) return { conversationId: null, messages: [], drafts: {} };
  return {
    conversationId: conversation.id,
    drafts: await loadAdminDraftCards(userId, conversation.id),
    messages: parseAdminMessages(conversation.messages).map((message) => {
      const shown = { ...message };
      delete shown.costMicros;
      return shown;
    }),
  };
}
