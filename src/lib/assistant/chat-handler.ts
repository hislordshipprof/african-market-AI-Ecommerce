import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { Prisma } from "@prisma/client";
import { CART_COOKIE, serializeCartCookie } from "../cart/cookies";
import { readBrowserId } from "../cart/browser";
import { CartError, getOrCreateCart } from "../cart/service";
import { lockConversationRow, storeScoped, storeScopedTransaction, takeRollingFileTurn } from "../db";
import { findStore } from "../get-store";
import { auth } from "../auth";
import {
  attachmentDescriptors,
  attachmentFailure,
  attachmentNote,
  descriptorsMatch,
  FILE_TURN_TOOLS,
  prepareAttachments,
  readAssistantRequest,
  type AttachmentDescriptor,
  type PreparedAttachment,
} from "./attachments";
import { scrubCardNumbers, scrubKnownStrings } from "./card-scrub";
import {
  ASSISTANT_DISABLED_CODE,
  ASSISTANT_DISABLED_MESSAGE,
  ASSISTANT_DISABLED_STATUS,
  assistantChatEnabled,
} from "./contract";
import { assistantMessageFromActions, replaceRecoveredTurn, replayAssistantMessage, replyStatus, stampAssistant } from "./replay";
import { writeServerChoices } from "./server-choices";
import { acceptanceForTurn } from "./shown";
import { clientIp } from "./client-ip";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { requireSameOrigin } from "../security/same-origin";
import { callCostMicros, type TokenUsage } from "./cost";
import { AssistantConfigError, assistantModelId, assistantProviderOptions, createAssistantModel } from "./model";
import { groundingTransform, keyedUnitPricesFromHistory } from "./grounding";
import { assistantSpendState, claimCapAlert, utcDay } from "./spend";
import { ASSISTANT_STATIC_PROMPT, storeContextMessage } from "./system-prompt";
import { assistantTools } from "./tools";

const WINDOW_MS = 60 * 60 * 1000;
const IP_LIMIT = 60;
const CART_LIMIT = 30;
const FILE_LIMIT = 10;
const LEASE_MS = 90_000;
const FIXED_ERROR = "Sorry, something went wrong. Please try again.";
const STEP_LIMIT_TEXT = "I've done as much as I can in one go. Tell me what you'd like next.";
const RESTING_MESSAGE = "The helper is resting right now. You can still shop and check out as usual.";

export interface ChatHandlerOptions {
  model?: LanguageModel;
  now?: () => Date;
  /** Test seam. Runs after the unlocked transcript read and before classification. */
  afterSnapshot?: (messages: UIMessage[]) => Promise<void>;
}

export function createChatHandler(options: ChatHandlerOptions = {}) {
  const now = options.now ?? (() => new Date());
  return async function POST(request: Request): Promise<Response> {
    if (!assistantChatEnabled()) {
      return jsonError(ASSISTANT_DISABLED_STATUS, ASSISTANT_DISABLED_CODE, ASSISTANT_DISABLED_MESSAGE);
    }
    const parsed = await readAssistantRequest(request);
    if (!parsed.ok) return jsonError(parsed.status, parsed.code, parsed.message);
    if (!requireSameOrigin(request)) return jsonError(403, "forbidden_origin", "This request was not sent from the store.");

    const slug = request.headers.get("x-store-slug");
    const store = slug ? await findStore(slug) : null;
    if (!store) return jsonError(404, "store_not_found", "Store not found.");
    if (store.status === "suspended") return jsonError(403, "store_suspended", "This store is not taking orders.");

    const at = now();
    const ip = await takeLimit(`assistant:ip:${clientIp(request.headers)}`, IP_LIMIT, at);
    if (!ip.ok) return rateLimited(ip.retryAfter);

    try {
      const spend = await assistantSpendState();
      if (spend.resting) {
        await claimCapAlert(utcDay(at));
        return jsonError(503, "assistant_resting", RESTING_MESSAGE);
      }
    } catch {
      return jsonError(503, "assistant_resting", RESTING_MESSAGE);
    }

    let model = options.model;
    if (!model) {
      try {
        model = createAssistantModel();
      } catch (error) {
        if (error instanceof AssistantConfigError) {
          return jsonError(503, "assistant_unavailable", "The helper is not available right now.");
        }
        throw error;
      }
    }
    const modelId = configuredModelId();

    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    const userId = session?.user?.id ?? null;
    const cookieCart = readCookie(request.headers.get("cookie"), CART_COOKIE);
    let cartId: string;
    try {
      cartId = await getOrCreateCart(
        store.id,
        cookieCart,
        userId,
        readBrowserId(request.headers.get("x-shop-browser"), request.headers.get("cookie")),
      );
    } catch (error) {
      if (error instanceof CartError) return jsonError(400, "invalid_request", "The cart could not be opened.");
      throw error;
    }

    const cartLimit = await takeLimit(`assistant:cart:${cartId}`, CART_LIMIT, at);
    if (!cartLimit.ok) return rateLimited(cartLimit.retryAfter);

    const headers = new Headers();
    if (cookieCart !== cartId) headers.append("set-cookie", serializeCartCookie(cartId));
    const lookedUp = await storeScoped(store.id).aiConversation.findUnique({
      where: { storeId_cartId: { storeId: store.id, cartId } },
    });
    const storedMessages = asMessages(lookedUp?.messages);
    if (options.afterSnapshot) await options.afterSnapshot(storedMessages);
    const storedUser = storedMessages.find((message) => message.role === "user" && message.id === parsed.id);
    const storedFiles = storedUser ? attachmentDescriptors(storedUser) : [];
    if (storedUser && parsed.files.length > 0 && !descriptorsMatch(storedFiles, parsed.files)) {
      return jsonError(400, "attachment_conflict", attachmentFailure("attachment_conflict").message);
    }
    const sameFiles = parsed.files.length === 0 || descriptorsMatch(storedFiles, parsed.files);
    if (sameFiles) {
      const replay = await replayCompletedTurn(store.id, cartId, parsed.id, headers, at);
      if (replay) return replay;
    }
    let fileTurn = parsed.files.length > 0 || storedFiles.length > 0;
    if (fileTurn && parsed.files.length === 0) {
      return jsonError(400, "attachment_missing", attachmentFailure("attachment_missing").message);
    }

    let prepared: PreparedAttachment[] = [];
    if (parsed.files.length > 0) {
      const slot = await takeRollingFileTurn(
        `assistant:files:cart:${cartId}`,
        BigInt(at.getTime()),
        BigInt(WINDOW_MS),
        FILE_LIMIT,
      );
      if (!slot.ok) {
        return jsonError(429, "attachment_rate_limited", "Too many files this hour. You can still type a message.", {
          "retry-after": String(slot.retryAfter),
        });
      }
      const processed = await prepareAttachments(parsed.files);
      if (!processed.ok) return jsonError(processed.status, processed.code, processed.message);
      prepared = processed.files;
    }

    const leasedAt = now();
    const turn = await takeTurn(
      store.id,
      cartId,
      userId,
      leasedAt,
      modelId,
      parsed.id,
      prepared.map((file) => file.descriptor.digest),
      parsed.replayOnly,
    );
    if (!turn) return jsonError(409, "assistant_busy", "The helper is still working on the previous message.");
    if ("empty" in turn) return jsonError(400, "invalid_request", "Write between 1 and 2000 characters.");
    if ("missing" in turn) return jsonError(400, "attachment_missing", attachmentFailure("attachment_missing").message);
    if ("conflict" in turn) return jsonError(400, "attachment_conflict", attachmentFailure("attachment_conflict").message);
    if ("replay" in turn) return replayAssistantMessage(turn.replay as UIMessage, headers);
    fileTurn = turn.fileTurn;

    const scrubbed = scrubCardNumbers(parsed.text).text;
    const userMessage: UIMessage = {
      id: parsed.id,
      role: "user",
      parts: [
        ...(scrubbed ? [{ type: "text" as const, text: scrubbed }] : []),
        ...prepared.map((file, index) => ({
          type: "data-attachment" as const,
          data: { ...file.descriptor, index: index + 1 },
        })),
      ],
    };
    const prior = asMessages(turn.messages);
    const alreadyThere = prior.some((message) => message.role === "user" && message.id === parsed.id);
    const withUser = alreadyThere ? prior : [...prior, userMessage];
    try {
      await storeScoped(store.id).aiConversation.update({
        where: { id: turn.id },
        data: { messages: withUser as unknown as Prisma.InputJsonValue },
      });
    } catch {
      console.error("[assistant] transcript not saved", turn.id);
      await releaseLease(store.id, turn.id);
      return jsonError(503, "assistant_unavailable", FIXED_ERROR);
    }

    const turnCtx = {
      storeId: store.id,
      cartId,
      conversationId: turn.id,
      actorUserId: userId,
      turnMessageId: parsed.id,
      acceptance: acceptanceForTurn(withUser, parsed.id, scrubbed),
    };
    const tools = assistantTools(turnCtx);
    const history = (await usableHistory(withUser, tools)).slice(-30);
    if (!history.some((message) => message.id === parsed.id)) {
      const current = withUser.find((message) => message.id === parsed.id);
      if (current) history.push(current);
    }
    const sentHistory = retryVisible(history, parsed.id, alreadyThere);
    let modelMessages: ModelMessage[];
    try {
      let attachmentIndex = 0;
      const visible = sentHistory.map((message) => {
        if (message.id !== parsed.id) return message;
        return {
          ...message,
          parts: message.parts.map((part) => {
            if (part.type !== "data-attachment") return part;
            const data = part.data as Record<string, unknown>;
            return { ...part, data: { ...data, turnId: parsed.id } };
          }),
        };
      });
      modelMessages = await convertToModelMessages(visible, {
        tools,
        convertDataPart: (part) => {
          if (part.type !== "data-attachment") return undefined;
          const data = part.data as AttachmentDescriptor & { index?: number; turnId?: string };
          attachmentIndex += 1;
          const note = attachmentNote(data, data.index ?? attachmentIndex);
          return { type: "text", text: data.turnId === parsed.id ? `${note}\nTURN:${parsed.id}` : note };
        },
      });
      if (prepared.length > 0) overlayCurrentFiles(modelMessages, parsed.id, scrubbed, prepared);
    } catch {
      console.error("[assistant] message could not be prepared", turn.id);
      await releaseLease(store.id, turn.id);
      return jsonError(503, "assistant_unavailable", FIXED_ERROR);
    }

    const result = streamText({
      model,
      messages: [
        {
          role: "system",
          content: ASSISTANT_STATIC_PROMPT,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        { role: "system", content: storeContextMessage(store, at) },
        ...modelMessages,
      ],
      allowSystemInMessages: true,
      tools,
      ...(fileTurn ? { activeTools: [...FILE_TURN_TOOLS] } : {}),
      toolCallConcurrency: 1,
      stopWhen: stepCountIs(8),
      maxOutputTokens: 1024,
      maxRetries: 0,
      streamRetries: 0,
      timeout: { totalMs: fileTurn ? 45_000 : 55_000 },
      prepareStep: ({ messages }) => ({ messages: scrubKnownStrings(messages) as typeof messages }),
      providerOptions: assistantProviderOptions(modelId),
      experimental_transform: groundingTransform({
        historyUnitPrices: keyedUnitPricesFromHistory(sentHistory),
        getAllowedCents: () => new Set([store.minimumOrderCents]),
        onStrip: (amount) => {
          const scrubbed = scrubCardNumbers(amount);
          const stored = scrubbed.removed > 0 ? scrubbed.text : amount;
          void storeScoped(store.id).aiAction.create({
            data: {
              storeId: store.id,
              conversationId: turn.id,
              tool: "grounding_strip",
              input: { amount: stored },
              output: {},
              ok: true,
            },
          }).catch((error: unknown) => {
            console.error("[assistant] grounding strip not saved", turn.id, error);
          });
        },
      }),
    });
    void result.consumeStream();

    const stream = createUIMessageStream({
      originalMessages: history,
      onError: () => FIXED_ERROR,
      onFinish: async (event) => {
        const keptIds = new Set(event.messages.map((message) => message.id));
        let status: "complete" | "failed" = "complete";
        try {
          const reason = await result.finishReason;
          if (reason === "error" || reason === "other") status = "failed";
        } catch {
          status = "failed";
        }
        const messages = scrubUiMessages(stampAssistant([
          ...withUser.filter((message) => !keptIds.has(message.id)),
          ...event.messages,
        ], status));
        await persistTurn({
          storeId: store.id,
          conversationId: turn.id,
          messages,
          result,
          modelId,
        });
      },
      execute: async ({ writer }) => {
        const reader = result.toUIMessageStream({ onError: () => FIXED_ERROR }).getReader();
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const outgoing = scrubOutboundChunk(next.value);
          if (outgoing) writer.write(outgoing as typeof next.value);
        }
        const steps = await Promise.resolve(result.steps).catch(() => []);
        const last = steps.at(-1);
        if (steps.length >= 8 && last?.finishReason === "tool-calls") {
          writer.write({ type: "text-start", id: "step-limit" });
          writer.write({ type: "text-delta", id: "step-limit", delta: STEP_LIMIT_TEXT });
          writer.write({ type: "text-end", id: "step-limit" });
          writer.write({ type: "data-step-limit", id: "step-limit", data: { text: STEP_LIMIT_TEXT } });
        } else if (await turnFinishedNormally(result)) {
          const replyText = await Promise.resolve(result.text).catch(() => "");
          await writeServerChoices({
            steps,
            replyText,
            ctx: turnCtx,
            write: (chunk) => {
              if (chunk.type === "tool-input-available") {
                writer.write({
                  type: "tool-input-available",
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  input: chunk.input,
                });
                return;
              }
              writer.write({
                type: "tool-output-available",
                toolCallId: chunk.toolCallId,
                output: chunk.output,
              });
            },
          });
        }
      },
    });

    return createUIMessageStreamResponse({
      stream,
      headers,
      consumeSseStream: ({ stream: sse }) => {
        void consumeStream({ stream: sse });
      },
    });
  };
}

async function turnFinishedNormally(result: { finishReason: PromiseLike<string> }): Promise<boolean> {
  try {
    const reason = await result.finishReason;
    return reason !== "error" && reason !== "other";
  } catch {
    return false;
  }
}

async function persistTurn(args: {
  storeId: string;
  conversationId: string;
  messages: UIMessage[];
  result: { steps: PromiseLike<Array<{ usage: unknown }>> };
  modelId: ReturnType<typeof assistantModelId>;
}) {
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = BigInt(0);
  try {
    const steps = await args.result.steps;
    for (const step of steps) {
      const usage = normalizeUsage(step.usage);
      try {
        cost += callCostMicros(args.modelId, usage);
      } catch {
        // An unknown model still saves the transcript. The cap check already failed closed.
      }
      tokensIn += Number(usage.inputTokens?.total ?? 0);
      tokensOut += Number(usage.outputTokens?.total ?? 0);
    }
  } catch {
    // The turn failed before usage was available. The user message is already stored.
  }
  try {
    await storeScoped(args.storeId).aiConversation.update({
      where: { id: args.conversationId },
      data: {
        messages: args.messages as unknown as Prisma.InputJsonValue,
        tokensIn: { increment: tokensIn },
        tokensOut: { increment: tokensOut },
        costMicros: { increment: cost },
        lastMessageAt: new Date(),
        inFlightUntil: null,
      },
    });
  } catch (error) {
    console.error("[assistant] transcript not saved", args.conversationId, error);
    await releaseLease(args.storeId, args.conversationId);
  }
}

function configuredModelId(): ReturnType<typeof assistantModelId> {
  try {
    return assistantModelId();
  } catch {
    return "claude-haiku-5-5";
  }
}

function normalizeUsage(usage: unknown): TokenUsage {
  const value = (usage ?? {}) as {
    inputTokens?: number | TokenUsage["inputTokens"];
    outputTokens?: number | TokenUsage["outputTokens"];
    inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  };
  if (value.inputTokens && typeof value.inputTokens === "object") {
    const output = value.outputTokens;
    return {
      inputTokens: value.inputTokens,
      outputTokens: output && typeof output === "object" ? output : { total: typeof output === "number" ? output : 0 },
    };
  }
  const details = value.inputTokenDetails ?? {};
  return {
    inputTokens: {
      total: typeof value.inputTokens === "number" ? value.inputTokens : 0,
      noCache: details.noCacheTokens,
      cacheRead: details.cacheReadTokens,
      cacheWrite: details.cacheWriteTokens,
    },
    outputTokens: { total: typeof value.outputTokens === "number" ? value.outputTokens : 0 },
  };
}

function retryVisible(messages: UIMessage[], clientId: string, alreadyThere: boolean): UIMessage[] {
  if (!alreadyThere) return messages;
  const index = messages.findIndex((message) => message.role === "user" && message.id === clientId);
  if (index < 0) return messages;
  const rest = messages.slice(index + 1);
  const nextUser = rest.findIndex((message) => message.role === "user");
  const span = nextUser === -1 ? rest : rest.slice(0, nextUser);
  const visible = span.some((message) => message.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text.trim() !== ""));
  if (visible) return messages;
  const marker: UIMessage = {
    id: `${clientId}-failed`,
    role: "assistant",
    metadata: { status: "failed" },
    parts: [{ type: "text", text: "partial" }],
  };
  return [...messages.slice(0, index + 1), marker, ...rest];
}

function coerceToolInputs(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (!("input" in part) || typeof part.input !== "string") return part;
      try {
        const parsed: unknown = JSON.parse(part.input);
        if (parsed && typeof parsed === "object") return { ...part, input: parsed };
      } catch {
        return part;
      }
      return part;
    }),
  }));
}

async function usableHistory(messages: UIMessage[], tools: ReturnType<typeof assistantTools>): Promise<UIMessage[]> {
  const normalized = coerceToolInputs(messages);
  const first = await safeValidateUIMessages({ messages: normalized, tools });
  if (first.success) return first.data;
  const kept = messages.flatMap((message) => {
    const parts = message.parts.filter((part) => part.type === "text" || part.type === "data-attachment");
    if (parts.length === 0) return [];
    return [{ ...message, parts }];
  });
  const second = await safeValidateUIMessages({ messages: kept, tools });
  return second.success ? second.data : kept;
}

async function takeTurn(
  storeId: string,
  cartId: string,
  userId: string | null,
  at: Date,
  modelId: ReturnType<typeof assistantModelId>,
  clientId: string,
  incomingDigests: string[],
  replayOnly = false,
) {
  try {
    return await claimFirstTurn(storeId, cartId, userId, at, modelId, clientId, incomingDigests, replayOnly);
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return claimFirstTurn(storeId, cartId, userId, at, modelId, clientId, incomingDigests, replayOnly);
  }
}

/** Upsert then claim. A lost insert race retries once; the lease decides who is busy. */
async function claimFirstTurn(
  storeId: string,
  cartId: string,
  userId: string | null,
  at: Date,
  modelId: ReturnType<typeof assistantModelId>,
  clientId: string,
  incomingDigests: string[],
  replayOnly = false,
) {
  const until = new Date(at.getTime() + LEASE_MS);
  const cart = await storeScoped(storeId).cart.findUnique({ where: { id: cartId } });
  return storeScopedTransaction(storeId, async (tx) => {
    await tx.aiConversation.upsert({
      where: { storeId_cartId: { storeId, cartId } },
      create: {
        storeId,
        cartId,
        customerId: cart?.customerId ?? null,
        model: modelId,
        messages: [],
      },
      update: userId ? { customerId: cart?.customerId ?? undefined } : {},
    });
    const row = await tx.aiConversation.findUnique({ where: { storeId_cartId: { storeId, cartId } } });
    if (!row) return null;
    await lockConversationRow(tx, row.id);
    const fresh = await tx.aiConversation.findUnique({ where: { id: row.id } });
    if (!fresh) return null;
    const freshMessages = asMessages(fresh.messages);
    const storedNow = freshMessages.find((message) => message.role === "user" && message.id === clientId);
    const storedNowFiles = storedNow ? attachmentDescriptors(storedNow) : [];
    const digestsMatch = storedNowFiles.length === incomingDigests.length
      && storedNowFiles.every((descriptor, index) => descriptor.digest === incomingDigests[index]);
    const finished = completedAssistant(freshMessages, clientId);
    if (finished && (incomingDigests.length === 0 || digestsMatch)) return { replay: finished };
    if (storedNow && incomingDigests.length > 0 && !digestsMatch) return { conflict: true as const };
    if (storedNowFiles.length > 0 && incomingDigests.length === 0) return { missing: true as const };
    if (fresh.inFlightUntil && fresh.inFlightUntil.getTime() > at.getTime()) return null;
    if (replayOnly) return { empty: true as const };
    await tx.aiConversation.update({
      where: { id: fresh.id },
      data: { inFlightUntil: until },
    });
    return {
      id: fresh.id,
      messages: fresh.messages,
      fileTurn: incomingDigests.length > 0 || storedNowFiles.length > 0,
    };
  });
}

function completedAssistant(messages: UIMessage[], clientId: string): UIMessage | null {
  const index = messages.findIndex((message) => message.role === "user" && message.id === clientId);
  if (index < 0) return null;
  const rest = messages.slice(index + 1);
  const nextUser = rest.findIndex((message) => message.role === "user");
  const span = nextUser === -1 ? rest : rest.slice(0, nextUser);
  const assistant = span.find((message) => message.role === "assistant");
  if (assistant && replyStatus(assistant) === "complete") return assistant;
  return null;
}

function scrubOutboundChunk(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const part = value as { type?: string; input?: unknown; output?: unknown; errorText?: unknown };
  if (part.type === "tool-input-delta") return null;
  if (typeof part.type === "string" && part.type.includes("error")) return scrubKnownStrings(part);
  if (part.type === "tool-input-available") return { ...part, input: scrubKnownStrings(part.input) };
  if (part.type === "tool-output-available" || part.type === "tool-result") {
    return { ...part, output: scrubKnownStrings(part.output) };
  }
  return value;
}

function scrubUiMessages(messages: UIMessage[]): UIMessage[] {
  return coerceToolInputs(messages).map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type === "text") return { ...part, text: scrubCardNumbers(part.text).text };
      if (part.type === "data-attachment") return part;
      return scrubKnownStrings(part) as typeof part;
    }),
  }));
}

function overlayCurrentFiles(messages: ModelMessage[], turnId: string, text: string, files: PreparedAttachment[]) {
  const marker = `TURN:${turnId}`;
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const marked = message.content.some((part) => part.type === "text" && part.text.includes(marker));
    if (!marked) continue;
    message.content = [
      ...files.map((file) => ({ type: "file" as const, data: file.modelBytes, mediaType: file.modelMediaType })),
      ...(text ? [{ type: "text" as const, text }] : []),
    ];
    message.providerOptions = { anthropic: { cacheControl: { type: "ephemeral" } } };
    return;
  }
}

async function releaseLease(storeId: string, conversationId: string) {
  await storeScoped(storeId).aiConversation.update({
    where: { id: conversationId },
    data: { inFlightUntil: null },
  }).catch(() => {});
}

async function takeLimit(key: string, max: number, at: Date): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const result = await takeRateLimit(key, max, WINDOW_MS, at.getTime());
  if (result.ok) return { ok: true };
  return { ok: false, retryAfter: result.retryAfter };
}

function rateLimited(retryAfter: number): Response {
  return jsonError(429, "rate_limited", "Too many messages. Please wait and try again.", {
    "retry-after": String(retryAfter),
  });
}

function jsonError(status: number, code: string, message: string, extra?: HeadersInit): Response {
  return Response.json({ error: { code, message } }, { status, headers: extra });
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function asMessages(value: unknown): UIMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is UIMessage => {
    return !!item && typeof item === "object" && "role" in item && "parts" in item;
  });
}

async function replayCompletedTurn(
  storeId: string,
  cartId: string,
  clientId: string,
  headers: Headers,
  at: Date,
): Promise<Response | null> {
  const existing = await storeScoped(storeId).aiConversation.findUnique({
    where: { storeId_cartId: { storeId, cartId } },
  });
  if (!existing) return null;
  const prior = asMessages(existing.messages);
  const index = prior.findIndex((message) => message.role === "user" && message.id === clientId);
  if (index < 0) return null;
  const rest = prior.slice(index + 1);
  const nextUser = rest.findIndex((message) => message.role === "user");
  const span = nextUser === -1 ? rest : rest.slice(0, nextUser);
  const assistant = span.find((message) => message.role === "assistant");
  if (assistant && replyStatus(assistant) === "complete") return replayAssistantMessage(assistant, headers);
  const recovered = await storeScopedTransaction(storeId, async (tx) => {
    await lockConversationRow(tx, existing.id);
    const fresh = await tx.aiConversation.findUnique({ where: { id: existing.id } });
    if (!fresh) return null;
    if (fresh.inFlightUntil && fresh.inFlightUntil.getTime() > at.getTime()) return null;
    const actions = await tx.aiAction.findMany({
      where: { conversationId: fresh.id },
      orderBy: { createdAt: "asc" },
    });
    const mine = actions.filter((action) => {
      const input = action.input;
      return !!input && typeof input === "object" && !Array.isArray(input)
        && (input as { _turn?: unknown })._turn === clientId;
    });
    if (mine.length === 0) return null;
    const freshMessages = asMessages(fresh.messages);
    const finishedNow = completedAssistant(freshMessages, clientId);
    if (finishedNow) return finishedNow;
    const storedUser = freshMessages.find((message) => message.role === "user" && message.id === clientId);
    const storedFiles = storedUser ? attachmentDescriptors(storedUser) : [];
    const wroteCart = mine.some((action) => (
      action.tool === "add_to_cart"
      || action.tool === "update_cart"
      || action.tool === "remove_from_cart"
      || action.tool === "set_swap_rule"
    ));
    if (storedFiles.length > 0 && !wroteCart) return null;
    const synthetic = assistantMessageFromActions(mine.map((action) => ({
      id: action.id,
      tool: action.tool,
      input: action.input,
      output: action.output,
    })));
    const next = replaceRecoveredTurn(asMessages(fresh.messages), clientId, synthetic);
    if (!next) return null;
    await tx.aiConversation.update({
      where: { id: fresh.id },
      data: { messages: next as unknown as Prisma.InputJsonValue, inFlightUntil: null },
    });
    return synthetic;
  });
  return recovered ? replayAssistantMessage(recovered, headers) : null;
}
