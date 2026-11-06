"use client";

import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { reconcileStoreCart, settleStoreCart, shouldSettleTurn } from "./cart-bridge";
import { AssistantRouteError, createAssistantFetch, mapRouteError } from "./route-errors";
import { retainAction } from "./session-retain";
import { undoCardAfter, type UndoAck } from "./undo";

export type UndoLabel = "undone" | "already_removed";

export type SessionSnapshot = {
  labels: Record<string, UndoLabel>;
  retryToken: string;
};

type RetryRecord = {
  seq: number;
  messageId: string;
  text: string;
  eligible: boolean;
};

type Attempt = {
  seq: number;
  messageId: string;
  hasFiles: boolean;
  settled: boolean;
};

type SettleOutcome = "success" | "retryable" | "disqualified" | "ignore";

type Session = {
  key: string;
  storeId: string;
  accountId: string | null;
  cartId: string | null;
  chat: Chat<UIMessage>;
  alive: boolean;
  seq: number;
  attempts: Attempt[];
  retry: RetryRecord | null;
  labels: Record<string, UndoLabel>;
  listeners: Set<() => void>;
  snapshot: SessionSnapshot;
};

const sessions = new Map<string, Session>();
const byChat = new WeakMap<Chat<UIMessage>, Session>();

const EMPTY_LABELS: Record<string, UndoLabel> = {};
export const EMPTY_SESSION_SNAPSHOT: SessionSnapshot = { labels: EMPTY_LABELS, retryToken: "" };

function sessionKey(storeId: string, accountId: string | null, cartId: string | null) {
  return `${storeId}\u0000${accountId ?? ""}\u0000${cartId ?? ""}`;
}

function publish(session: Session) {
  session.snapshot = {
    labels: session.labels,
    retryToken: session.retry ? `${session.retry.messageId}:${session.retry.eligible ? "1" : "0"}` : "",
  };
  for (const listener of session.listeners) listener();
}

function live(chat: Chat<UIMessage>): Session | null {
  const session = byChat.get(chat);
  if (!session?.alive) return null;
  return session;
}

function drop(session: Session) {
  session.alive = false;
  session.retry = null;
  publish(session);
  void session.chat.stop?.();
  sessions.delete(session.key);
}

function releaseFileBytes(chat: Chat<UIMessage>, keepImages = false) {
  const next = chat.messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "file" || typeof part.url !== "string" || !part.url.startsWith("data:")) return part;
      if (keepImages && part.mediaType.startsWith("image/")) return part;
      return { ...part, url: "" };
    }),
  }));
  const held = JSON.stringify(chat.messages);
  if (JSON.stringify(next) === held) return;
  chat.messages = next;
}

function isAbort(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && (error as { name: string }).name === "AbortError";
}

function outcomeFromError(error: unknown): SettleOutcome {
  if (isAbort(error)) return "ignore";
  const route = error instanceof AssistantRouteError
    ? error
    : error instanceof Error && error.cause instanceof AssistantRouteError
      ? error.cause
      : null;
  if (!route) return "retryable";
  const view = mapRouteError({ code: route.code, retryAfter: route.retryAfter, parsed: route.parsed });
  return view.retry ? "retryable" : "disqualified";
}

function readMessageId(body: BodyInit | null | undefined): string | null {
  let text = "";
  if (typeof body === "string") text = body;
  else if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
  else return null;
  try {
    const parsed = JSON.parse(text) as { message?: { id?: unknown } };
    return typeof parsed.message?.id === "string" ? parsed.message.id : null;
  } catch {
    return null;
  }
}

function claimSeq(session: Session | null, body: BodyInit | null | undefined): number {
  if (!session?.alive) return 0;
  const id = readMessageId(body);
  if (!id) return 0;
  let found = 0;
  for (const attempt of session.attempts) {
    if (attempt.messageId === id && !attempt.settled && attempt.seq > found) found = attempt.seq;
  }
  return found;
}

function finishOutcome(event: { isAbort: boolean; isDisconnect: boolean; isError: boolean; finishReason?: string }): SettleOutcome {
  if (event.isAbort) return "ignore";
  if (event.isError || event.isDisconnect || event.finishReason === "error") return "retryable";
  return "success";
}

function createChat(storeId: string, holder: { session: Session | null }): Chat<UIMessage> {
  const attempt = { seq: 0 };
  const chat = new Chat<UIMessage>({
    transport: new DefaultChatTransport({
      api: "/api/assistant/chat",
      credentials: "same-origin",
      fetch: async (input, init) => {
        const seq = claimSeq(holder.session, init?.body);
        attempt.seq = seq;
        try {
          return await createAssistantFetch()(input, init);
        } catch (error) {
          if (seq !== 0) settleAttempt(chat, seq, outcomeFromError(error));
          throw error;
        }
      },
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { message: messages.at(-1) },
      }),
    }),
    sendAutomaticallyWhen: () => false,
    onError: () => {
      reconcileStoreCart(storeId);
    },
    onFinish: (event) => {
      releaseFileBytes(chat, true);
      if (attempt.seq !== 0) settleAttempt(chat, attempt.seq, finishOutcome(event));
      if (!shouldSettleTurn(event)) return;
      void settleStoreCart(storeId);
    },
  });
  return chat;
}

/**
 * One chat per store. A guest claim of the same cart keeps the transcript.
 * The first cart id, once the cookie exists, adopts the chat that started without one.
 * A different account or a different cart drops that store's chat.
 */
export function retainSession(input: {
  storeId: string;
  accountId: string | null;
  cartId: string | null;
  loading: boolean;
}): Chat<UIMessage> {
  for (const session of sessions.values()) {
    if (session.storeId !== input.storeId) releaseFileBytes(session.chat);
  }
  const existing = [...sessions.values()].find((session) => session.storeId === input.storeId);
  const action = retainAction(existing ?? null, input);
  if (existing && (action === "keep" || action === "adopt")) {
    if (action === "adopt") {
      const claim = existing.accountId == null && input.accountId != null;
      const key = sessionKey(input.storeId, claim ? input.accountId : existing.accountId, input.cartId ?? existing.cartId);
      sessions.delete(existing.key);
      existing.key = key;
      existing.accountId = claim ? input.accountId : existing.accountId;
      existing.cartId = input.cartId ?? existing.cartId;
      sessions.set(key, existing);
    }
    return existing.chat;
  }
  if (existing && action === "reset") drop(existing);
  const holder: { session: Session | null } = { session: null };
  const chat = createChat(input.storeId, holder);
  const labels = {};
  const session: Session = {
    key: sessionKey(input.storeId, input.accountId, input.cartId),
    storeId: input.storeId,
    accountId: input.accountId,
    cartId: input.cartId,
    chat,
    alive: true,
    seq: 0,
    attempts: [],
    retry: null,
    labels,
    listeners: new Set(),
    snapshot: { labels, retryToken: "" },
  };
  holder.session = session;
  byChat.set(chat, session);
  sessions.set(session.key, session);
  return chat;
}

export function resetAssistantSessions(): void {
  for (const session of [...sessions.values()]) drop(session);
}

/** A customer send that passed the composer. File turns are not kept for Retry. */
export function noteAcceptedSend(chat: Chat<UIMessage>, input: {
  messageId: string;
  text: string;
  hasFiles: boolean;
}): number {
  const session = live(chat);
  if (!session) return 0;
  const seq = session.seq + 1;
  session.seq = seq;
  session.attempts.push({ seq, messageId: input.messageId, hasFiles: input.hasFiles, settled: false });
  if (input.hasFiles) session.retry = null;
  else session.retry = { seq, messageId: input.messageId, text: input.text.slice(0, 2000), eligible: false };
  publish(session);
  return seq;
}

/** Apply the outcome of one accepted send. A newer send or a dead session wins. */
export function settleAttempt(chat: Chat<UIMessage>, seq: number, outcome: SettleOutcome): void {
  const session = byChat.get(chat);
  if (!session) return;
  const attempt = session.attempts.find((item) => item.seq === seq);
  if (!attempt || attempt.settled) return;
  attempt.settled = true;
  if (!session.alive || outcome === "ignore") return;
  if (attempt.hasFiles) return;
  if (!session.retry || session.retry.seq !== seq) return;
  if (outcome === "retryable") session.retry = { ...session.retry, eligible: true };
  else session.retry = null;
  publish(session);
}

export type RetryOffer =
  | { kind: "text"; messageId: string; text: string }
  | { kind: "files"; messageId: string; text: string };

/**
 * What Retry may send for this turn. Terminal errors and a message rate limit
 * suppress it. An open file flight resends that flight. A text failure resends
 * its own words and never a file added to the composer afterwards.
 */
export function retryOffer(chat: Chat<UIMessage>, input: {
  routeCode: string | null;
  terminal: boolean;
  openFileFlight: { messageId: string; text: string } | null;
}): RetryOffer | null {
  if (input.terminal || input.routeCode === "rate_limited") return null;
  if (input.openFileFlight) {
    return { kind: "files", messageId: input.openFileFlight.messageId, text: input.openFileFlight.text };
  }
  const text = visibleRetry(chat);
  if (!text) return null;
  return { kind: "text", messageId: text.messageId, text: text.text };
}

/** Original text only. Files sitting in the composer belong to a later send. */
export function partsForRetry(
  offer: Extract<RetryOffer, { kind: "text" }>,
  composerFiles: readonly { type: string }[],
): Array<{ type: "text"; text: string }> {
  void composerFiles;
  return [{ type: "text", text: offer.text }];
}

/** Retry for the latest customer message still in this chat. Missing and older ids are not offered. */
export function visibleRetry(chat: Chat<UIMessage>): { messageId: string; text: string } | null {
  const session = live(chat);
  const retry = session?.retry;
  if (!retry?.eligible) return null;
  const message = chat.messages.find((item) => item.id === retry.messageId);
  if (!message || message.role !== "user") return null;
  let latest = "";
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const candidate = chat.messages[index];
    if (candidate?.role === "user") {
      latest = candidate.id;
      break;
    }
  }
  if (latest !== retry.messageId) return null;
  return { messageId: retry.messageId, text: retry.text };
}

export function undoLabelsForChat(chat: Chat<UIMessage>): Record<string, UndoLabel> {
  const session = live(chat);
  return session ? session.snapshot.labels : EMPTY_LABELS;
}

export function commitUndoLabel(chat: Chat<UIMessage>, additionId: string, label: UndoLabel): void {
  const session = live(chat);
  if (!session || session.labels[additionId] === label) return;
  session.labels = { ...session.labels, [additionId]: label };
  publish(session);
}

export function acknowledgeUndo(chat: Chat<UIMessage>, additionId: string, ack: UndoAck, refresh: "ok" | "failed"): void {
  const view = undoCardAfter(ack, refresh);
  if (view === "unchanged") return;
  commitUndoLabel(chat, additionId, view === "undone" ? "undone" : "already_removed");
}

export function sessionSnapshot(chat: Chat<UIMessage>): SessionSnapshot {
  const session = live(chat);
  return session ? session.snapshot : EMPTY_SESSION_SNAPSHOT;
}

export function subscribeSessionMemory(chat: Chat<UIMessage>, listener: () => void): () => void {
  const session = byChat.get(chat);
  if (!session) return () => {};
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}
