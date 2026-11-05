"use client";

import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { createAssistantFetch } from "./route-errors";
import { reconcileStoreCart, settleStoreCart, shouldSettleTurn } from "./cart-bridge";
import { retainAction } from "./session-retain";

type Session = {
  key: string;
  storeId: string;
  accountId: string | null;
  cartId: string | null;
  chat: Chat<UIMessage>;
};

const sessions = new Map<string, Session>();

function sessionKey(storeId: string, accountId: string | null, cartId: string | null) {
  return `${storeId}\u0000${accountId ?? ""}\u0000${cartId ?? ""}`;
}

function createChat(storeId: string): Chat<UIMessage> {
  return new Chat<UIMessage>({
    transport: new DefaultChatTransport({
      api: "/api/assistant/chat",
      credentials: "same-origin",
      fetch: createAssistantFetch(),
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { message: messages.at(-1) },
      }),
    }),
    sendAutomaticallyWhen: () => false,
    onError: () => {
      reconcileStoreCart(storeId);
    },
    onFinish: (event) => {
      if (!shouldSettleTurn(event)) return;
      void settleStoreCart(storeId);
    },
  });
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
  if (existing && action === "reset") {
    void existing.chat.stop?.();
    sessions.delete(existing.key);
  }
  const key = sessionKey(input.storeId, input.accountId, input.cartId);
  const session: Session = {
    key,
    storeId: input.storeId,
    accountId: input.accountId,
    cartId: input.cartId,
    chat: createChat(input.storeId),
  };
  sessions.set(key, session);
  return session.chat;
}

export function resetAssistantSessions(): void {
  for (const session of sessions.values()) void session.chat.stop?.();
  sessions.clear();
}
