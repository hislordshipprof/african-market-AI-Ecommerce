import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { Prisma } from "@prisma/client";
import { CART_COOKIE, serializeCartCookie } from "../cart/cookies";
import { CartError, getOrCreateCart } from "../cart/service";
import { claimConversationLease, rateLimitUpsert, storeScoped, storeScopedTransaction } from "../db";
import { findStore } from "../get-store";
import { auth } from "../auth";
import { scrubCardNumbers } from "./card-scrub";
import {
  ASSISTANT_DISABLED_CODE,
  ASSISTANT_DISABLED_MESSAGE,
  ASSISTANT_DISABLED_STATUS,
  assistantChatEnabled,
} from "./contract";
import { assistantMessageFromActions, replayAssistantMessage } from "./replay";
import { clientIp } from "./client-ip";
import { callCostMicros, type TokenUsage } from "./cost";
import { AssistantConfigError, assistantModelId, assistantProviderOptions, createAssistantModel } from "./model";
import { groundingTransform } from "./grounding";
import { assistantSpendState, claimCapAlert, utcDay } from "./spend";
import { ASSISTANT_STATIC_PROMPT, storeContextMessage } from "./system-prompt";
import { assistantTools } from "./tools";

const WINDOW_MS = 60 * 60 * 1000;
const IP_LIMIT = 60;
const CART_LIMIT = 30;
const LEASE_MS = 90_000;
const BODY_LIMIT = 16 * 1024;
const FIXED_ERROR = "Sorry, something went wrong. Please try again.";
const STEP_LIMIT_TEXT = "I've done as much as I can in one go. Tell me what you'd like next.";
const RESTING_MESSAGE = "The helper is resting right now. You can still shop and check out as usual.";

export interface ChatHandlerOptions {
  model?: LanguageModel;
  now?: () => Date;
}

export function createChatHandler(options: ChatHandlerOptions = {}) {
  const now = options.now ?? (() => new Date());
  return async function POST(request: Request): Promise<Response> {
    if (!assistantChatEnabled()) {
      return jsonError(ASSISTANT_DISABLED_STATUS, ASSISTANT_DISABLED_CODE, ASSISTANT_DISABLED_MESSAGE);
    }
    const parsed = await readUserMessage(request);
    if (!parsed.ok) return jsonError(400, "invalid_request", parsed.message);
    if (!originAllowed(request)) return jsonError(403, "forbidden_origin", "This request was not sent from the store.");

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
      cartId = await getOrCreateCart(store.id, cookieCart, userId);
    } catch (error) {
      if (error instanceof CartError) return jsonError(400, "invalid_request", "The cart could not be opened.");
      throw error;
    }

    const cartLimit = await takeLimit(`assistant:cart:${cartId}`, CART_LIMIT, at);
    if (!cartLimit.ok) return rateLimited(cartLimit.retryAfter);

    const headers = new Headers();
    if (cookieCart !== cartId) headers.append("set-cookie", serializeCartCookie(cartId));
    const replay = await replayCompletedTurn(store.id, cartId, parsed.id, headers, at);
    if (replay) return replay;

    const turn = await takeTurn(store.id, cartId, userId, at, modelId);
    if (!turn) return jsonError(409, "assistant_busy", "The helper is still working on the previous message.");

    const scrubbed = scrubCardNumbers(parsed.text).text;
    const userMessage: UIMessage = {
      id: parsed.id,
      role: "user",
      parts: [{ type: "text", text: scrubbed }],
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

    const tools = assistantTools({
      storeId: store.id,
      cartId,
      conversationId: turn.id,
      actorUserId: userId,
      turnMessageId: parsed.id,
    });
    const history = (await usableHistory(withUser, tools)).slice(-30);
    const modelMessages = await convertToModelMessages(history);

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
      toolCallConcurrency: 1,
      stopWhen: stepCountIs(8),
      maxOutputTokens: 1024,
      maxRetries: 0,
      streamRetries: 0,
      timeout: { totalMs: 55_000 },
      providerOptions: assistantProviderOptions(modelId),
      experimental_transform: groundingTransform({
        onStrip: (amount) => {
          void storeScoped(store.id).aiAction.create({
            data: {
              storeId: store.id,
              conversationId: turn.id,
              tool: "grounding_strip",
              input: { amount },
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
        const messages = [
          ...withUser.filter((message) => !keptIds.has(message.id)),
          ...event.messages,
        ];
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
          writer.write(next.value);
        }
        const steps = await Promise.resolve(result.steps).catch(() => []);
        const last = steps.at(-1);
        if (steps.length >= 8 && last?.finishReason === "tool-calls") {
          writer.write({ type: "text-start", id: "step-limit" });
          writer.write({ type: "text-delta", id: "step-limit", delta: STEP_LIMIT_TEXT });
          writer.write({ type: "text-end", id: "step-limit" });
          writer.write({ type: "data-step-limit", id: "step-limit", data: { text: STEP_LIMIT_TEXT } });
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

async function usableHistory(messages: UIMessage[], tools: ReturnType<typeof assistantTools>): Promise<UIMessage[]> {
  const first = await safeValidateUIMessages({ messages, tools });
  if (first.success) return first.data;
  const textOnly = messages.flatMap((message) => {
    const parts = message.parts.filter((part) => part.type === "text");
    if (parts.length === 0) return [];
    return [{ ...message, parts }];
  });
  const second = await safeValidateUIMessages({ messages: textOnly, tools });
  return second.success ? second.data : textOnly;
}

async function takeTurn(
  storeId: string,
  cartId: string,
  userId: string | null,
  at: Date,
  modelId: ReturnType<typeof assistantModelId>,
) {
  try {
    return await claimFirstTurn(storeId, cartId, userId, at, modelId);
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return claimFirstTurn(storeId, cartId, userId, at, modelId);
  }
}

/** Upsert then claim. A lost insert race retries once; the lease decides who is busy. */
async function claimFirstTurn(
  storeId: string,
  cartId: string,
  userId: string | null,
  at: Date,
  modelId: ReturnType<typeof assistantModelId>,
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
    return claimConversationLease(tx, storeId, cartId, until, at);
  });
}

async function releaseLease(storeId: string, conversationId: string) {
  await storeScoped(storeId).aiConversation.update({
    where: { id: conversationId },
    data: { inFlightUntil: null },
  }).catch(() => {});
}

async function takeLimit(key: string, max: number, at: Date): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const nowMs = BigInt(at.getTime());
  const { count, lastRequest } = await rateLimitUpsert(key, nowMs, nowMs - BigInt(WINDOW_MS));
  if (count <= max) return { ok: true };
  const retryAfter = Math.max(1, Math.ceil((Number(lastRequest) + WINDOW_MS - at.getTime()) / 1000));
  return { ok: false, retryAfter };
}

function rateLimited(retryAfter: number): Response {
  return jsonError(429, "rate_limited", "Too many messages. Please wait and try again.", {
    "retry-after": String(retryAfter),
  });
}

function jsonError(status: number, code: string, message: string, extra?: HeadersInit): Response {
  return Response.json({ error: { code, message } }, { status, headers: extra });
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
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
  const assistant = prior.slice(index + 1).find((message) => message.role === "assistant");
  if (assistant) return replayAssistantMessage(assistant, headers);
  if (existing.inFlightUntil && existing.inFlightUntil.getTime() > at.getTime()) return null;
  const actions = await storeScoped(storeId).aiAction.findMany({
    where: { conversationId: existing.id },
    orderBy: { createdAt: "asc" },
  });
  const mine = actions.filter((action) => {
    const input = action.input;
    return !!input && typeof input === "object" && !Array.isArray(input)
      && (input as { _turn?: unknown })._turn === clientId;
  });
  if (mine.length === 0) return null;
  const synthetic = assistantMessageFromActions(mine.map((action) => ({
    id: action.id,
    tool: action.tool,
    input: action.input,
    output: action.output,
  })));
  await storeScoped(storeId).aiConversation.update({
    where: { id: existing.id },
    data: { messages: [...prior, synthetic] as unknown as Prisma.InputJsonValue, inFlightUntil: null },
  });
  return replayAssistantMessage(synthetic, headers);
}

async function readUserMessage(request: Request): Promise<{ ok: true; text: string; id: string } | { ok: false; message: string }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { ok: false, message: "Send a JSON message." };
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > BODY_LIMIT) return { ok: false, message: "That message is too large." };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, message: "Send a JSON message." };
  }
  const message = body && typeof body === "object" ? (body as { message?: unknown }).message : undefined;
  if (!message || typeof message !== "object") return { ok: false, message: "Send one user message." };
  const record = message as { role?: unknown; parts?: unknown };
  if (record.role !== "user" || !Array.isArray(record.parts)) {
    return { ok: false, message: "Send one user message." };
  }
  if (record.parts.some((part) => {
    if (!part || typeof part !== "object") return true;
    const typed = part as { type?: unknown; text?: unknown };
    return typed.type !== "text" || typeof typed.text !== "string";
  })) {
    return { ok: false, message: "Send plain text." };
  }
  const text = record.parts.map((part) => (part as { text: string }).text).join("").trim();
  if (text.length < 1 || text.length > 2000) return { ok: false, message: "Write between 1 and 2000 characters." };
  const rawId = typeof (record as { id?: unknown }).id === "string" ? (record as { id: string }).id : "";
  const id = /^[A-Za-z0-9_-]{8,80}$/.test(rawId) ? rawId : generateId();
  return { ok: true, text, id };
}
