import { DefaultChatTransport } from "ai";
import { describe, expect, it } from "vitest";
import { ASSISTANT_ROUTE_CODES } from "../contract";
import {
  AssistantRouteError,
  createAssistantFetch,
  mapRouteError,
  minutesFromRetryAfter,
} from "./route-errors";

describe("assistant route errors", () => {
  it("every error code the chat handler can return maps to a state with a search link", () => {
    for (const code of ASSISTANT_ROUTE_CODES) {
      const view = mapRouteError({ code, parsed: true });
      expect(view.searchHref).toBe("/search");
      expect(view.title.length).toBeGreaterThan(0);
      expect(view.title).not.toMatch(/tomorrow/i);
      expect(view.title).not.toContain("{");
    }
    expect(mapRouteError({ code: "assistant_resting", parsed: true }).terminal).toBe(true);
    expect(mapRouteError({ code: "assistant_unavailable", parsed: true }).title).toBe(
      "The helper isn't available right now.",
    );
    expect(mapRouteError({ code: "store_suspended", parsed: true }).title).toBe(
      "This store isn't taking orders right now.",
    );
    expect(mapRouteError({ code: "assistant_busy", parsed: true })).toMatchObject({
      title: "Still working on your last message.",
      retry: true,
    });
    expect(mapRouteError({ code: "invalid_request", parsed: true }).title).toBe("Couldn't send that.");
    expect(mapRouteError({ code: "forbidden_origin", parsed: true }).title).toBe(
      "Sorry, something went wrong. Please try again.",
    );
    expect(mapRouteError({ code: "store_not_found", parsed: true }).searchHref).toBe("/search");
    expect(mapRouteError({ code: "nope", parsed: true }).retry).toBe(true);
  });

  it("retry-after rounds up to minutes and tolerates a missing header", () => {
    expect(minutesFromRetryAfter("59")).toBe(1);
    expect(minutesFromRetryAfter("120")).toBe(2);
    expect(minutesFromRetryAfter("3600")).toBe(60);
    expect(minutesFromRetryAfter(null)).toBeNull();
    expect(minutesFromRetryAfter("")).toBeNull();
    expect(mapRouteError({ code: "rate_limited", parsed: true, retryAfter: "120" }).title).toBe(
      "Too many messages. Try again in about 2 minutes.",
    );
    expect(mapRouteError({ code: "rate_limited", parsed: true, retryAfter: "59" }).title).toBe(
      "Too many messages. Try again in about 1 minute.",
    );
    expect(mapRouteError({ code: "rate_limited", parsed: true }).title).toBe(
      "Too many messages. Try again in a little while.",
    );
  });

  it("a non-JSON 5xx and a network failure map to the fixed error", async () => {
    const fetchImpl = createAssistantFetch(async () => new Response("<html>timeout</html>", { status: 504 }));
    await expect(fetchImpl("/api/assistant/chat", { method: "POST" })).rejects.toBeInstanceOf(AssistantRouteError);
    try {
      await fetchImpl("/api/assistant/chat", { method: "POST" });
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantRouteError);
      const route = error as AssistantRouteError;
      expect(route.message).toBe("Sorry, something went wrong. Please try again.");
      expect(route.message).not.toContain("timeout");
      expect(route.parsed).toBe(false);
      expect(mapRouteError({ code: route.code, parsed: route.parsed }).title).toBe(route.message);
    }

    const network = createAssistantFetch(async () => {
      throw new Error("connect ECONNRESET raw body");
    });
    await expect(network("/api/assistant/chat")).rejects.toMatchObject({
      message: "Sorry, something went wrong. Please try again.",
      parsed: false,
    });
  });

  it("actual transport preserves RequestInit and sanitizes all malformed responses and retry headers", async () => {
    expect(minutesFromRetryAfter("0")).toBeNull();
    expect(minutesFromRetryAfter("-5")).toBeNull();
    expect(minutesFromRetryAfter("nope")).toBeNull();
    expect(minutesFromRetryAfter("Infinity")).toBeNull();
    expect(minutesFromRetryAfter("NaN")).toBeNull();
    const now = Date.parse("2026-11-05T12:00:00.000Z");
    expect(minutesFromRetryAfter("Wed, 05 Nov 2026 12:02:00 GMT", now)).toBe(2);
    expect(mapRouteError({ code: "rate_limited", parsed: true, retryAfter: "0" }).title).toBe(
      "Too many messages. Try again in a little while.",
    );

    let seen: RequestInit | undefined;
    const transport = new DefaultChatTransport({
      api: "/api/assistant/chat",
      credentials: "include",
      headers: { "x-test": "kept" },
      fetch: createAssistantFetch(async (_input, init) => {
        seen = init;
        return new Response("not-json", {
          status: 502,
          headers: { "retry-after": "Infinity" },
        });
      }),
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { message: messages.at(-1) },
      }),
    });
    const signal = new AbortController().signal;
    await expect(transport.sendMessages({
      trigger: "submit-message",
      chatId: "c",
      messageId: "m",
      messages: [{ id: "m", role: "user", parts: [{ type: "text", text: "egusi" }] }],
      abortSignal: signal,
    })).rejects.toBeInstanceOf(AssistantRouteError);
    expect(seen?.credentials).toBe("include");
    expect(seen?.signal).toBe(signal);
    expect(new Headers(seen?.headers).get("x-test")).toBe("kept");
    const raw = typeof seen?.body === "string" ? seen.body : "";
    expect(JSON.parse(raw)).toEqual({
      message: { id: "m", role: "user", parts: [{ type: "text", text: "egusi" }] },
    });
  });

  it("a finish event split across chunks is still a completed stream", async () => {
    const chunks = [
      'data: {"type":"fi',
      'nish","finishReason":"stop"}\n\ndata: [DO',
      "NE]\n\n",
    ];
    const fetch = createAssistantFetch(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const response = await fetch("/api/assistant/chat", { method: "POST" });
    await expect(response.text()).resolves.toContain("[DONE]");
  });

  it("a chat stream that ends before finish is an error the sheet can retry", async () => {
    const fetch = createAssistantFetch(async () => new Response(
      'data: {"type":"start"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const response = await fetch("/api/assistant/chat", { method: "POST" });
    await expect(response.text()).rejects.toBeInstanceOf(AssistantRouteError);
  });
});
