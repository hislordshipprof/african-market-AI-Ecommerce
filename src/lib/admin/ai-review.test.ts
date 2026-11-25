import { describe, expect, it } from "vitest";
import {
  actionFlagReasons,
  chatKey,
  copilotTranscript,
  filterInbox,
  inboxCounts,
  nextUnlabelled,
  orderInbox,
  parseChatKey,
  shopperTranscript,
  type InboxRow,
} from "./ai-review";

/** The default threshold: 2 cents. */
const T = 20_000;

describe("actionFlagReasons", () => {
  it("flags an amount the grounder removed", () => {
    expect(actionFlagReasons({ tool: "grounding_strip", ok: true, output: {} }, T)).toEqual(["amount_removed"]);
  });

  it("flags a made-up id a tool refused, at the top level, in add_to_cart items, or in notFound", () => {
    expect(actionFlagReasons({ tool: "update_cart", ok: false, output: { ok: false, code: "line_not_found" } }, T)).toEqual(["made_up_id"]);
    expect(actionFlagReasons({
      tool: "add_to_cart",
      ok: true,
      output: { ok: true, items: [{ ok: true, lineId: "l1" }, { ok: false, code: "variant_not_found" }] },
    }, T)).toEqual(["made_up_id"]);
    expect(actionFlagReasons({ tool: "show_products", ok: true, output: { ok: true, cards: [], notFound: ["lst_fake"] } }, T)).toEqual(["made_up_id"]);
    expect(actionFlagReasons({ tool: "show_products", ok: true, output: { ok: true, cards: [], notFound: [] } }, T)).toEqual([]);
  });

  it("flags a constraint or cannot-confirm refusal", () => {
    expect(actionFlagReasons({ tool: "add_to_cart", ok: false, output: { ok: false, code: "cannot_confirm" } }, T)).toEqual(["needs_refusal"]);
    expect(actionFlagReasons({
      tool: "add_to_cart",
      ok: true,
      output: { ok: true, items: [{ ok: false, code: "excluded" }, { ok: false, code: "variant_not_found" }] },
    }, T)).toEqual(["made_up_id", "needs_refusal"]);
    expect(actionFlagReasons({ tool: "show_products", ok: true, output: { ok: true, cards: [], notFound: [], excluded: [{ listingId: "x" }] } }, T)).toEqual(["needs_refusal"]);
  });

  it("flags every forward_to_store call", () => {
    expect(actionFlagReasons({ tool: "forward_to_store", ok: true, output: { ok: true } }, T)).toEqual(["forwarded"]);
  });

  it("flags a turn over the cost threshold it is given only (#561 platform setting)", () => {
    expect(actionFlagReasons({ tool: "turn_cost", ok: true, output: { costMicros: 50_001 } }, 50_000)).toEqual(["costly_turn"]);
    expect(actionFlagReasons({ tool: "turn_cost", ok: true, output: { costMicros: 50_000 } }, 50_000)).toEqual([]);
    expect(actionFlagReasons({ tool: "turn_cost", ok: true, output: { costMicros: 30_000 } }, 50_000)).toEqual([]);
    expect(actionFlagReasons({ tool: "turn_cost", ok: true, output: { costMicros: 30_000 } }, 10_000)).toEqual(["costly_turn"]);
  });

  it("does not flag ordinary refusals or reads", () => {
    expect(actionFlagReasons({ tool: "add_to_cart", ok: false, output: { ok: false, code: "unavailable" } }, T)).toEqual([]);
    expect(actionFlagReasons({ tool: "search_catalog", ok: true, output: { ok: true, items: [{ listingId: "a" }] } }, T)).toEqual([]);
    expect(actionFlagReasons({ tool: "get_order_status", ok: false, output: { ok: false, code: "order_not_found" } }, T)).toEqual([]);
  });
});

describe("shopperTranscript", () => {
  it("keeps text and tool calls, and shows attachments as name, type, size and pages only", () => {
    const messages = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "Do you have this?" },
          {
            type: "data-attachment",
            data: { name: "list.jpg", mediaType: "image/jpeg", bytes: 2048, digest: "abc", index: 1, url: "data:image/jpeg;base64,AAAA", content: "AAAA" },
          },
        ],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "thinking" },
          { type: "tool-search_catalog", toolCallId: "c1", state: "output-available", input: { query: "egusi" }, output: { ok: true, items: [] } },
          { type: "text", text: "We have egusi." },
        ],
      },
    ];
    const out = shopperTranscript(messages);
    expect(out).toEqual([
      {
        id: "u1",
        role: "shopper",
        parts: [
          { kind: "text", text: "Do you have this?" },
          { kind: "attachment", name: "list.jpg", mediaType: "image/jpeg", bytes: 2048, pages: null },
        ],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { kind: "tool", tool: "search_catalog", input: { query: "egusi" }, output: { ok: true, items: [] } },
          { kind: "text", text: "We have egusi." },
        ],
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("AAAA");
  });

  it("returns nothing for a malformed transcript", () => {
    expect(shopperTranscript(null)).toEqual([]);
    expect(shopperTranscript([{ role: "user" }, "x"])).toEqual([]);
  });
});

describe("copilotTranscript", () => {
  it("maps owner and assistant turns, with the choices offered", () => {
    expect(copilotTranscript([
      { role: "owner", text: "sold 3 gari" },
      { role: "assistant", text: "Which gari?", messageId: "m1", costMicros: 900, choices: [{ candidates: [{ listingId: "l1", name: "Gari white" }], kind: "counter_sale", quantity: 3, statusValue: null, nearOnly: false, createdAt: "x", expiresAt: "y" }] },
    ])).toEqual([
      { id: "0", role: "owner", parts: [{ kind: "text", text: "sold 3 gari" }] },
      { id: "1", role: "assistant", parts: [{ kind: "text", text: "Which gari?" }, { kind: "choices", names: ["Gari white"] }] },
    ]);
  });
});

describe("copilotTranscript for the platform admin assistant", () => {
  it("reads admin turns and drops what the reply cost", () => {
    expect(copilotTranscript([
      { role: "admin", text: "Which stores are past due?" },
      { role: "assistant", text: "Two stores.", messageId: "m1", costMicros: 900, links: [{ label: "Store", href: "/admin/stores/s1" }] },
      { role: "owner", text: "not an admin turn" },
    ], "admin")).toEqual([
      { id: "0", role: "admin", parts: [{ kind: "text", text: "Which stores are past due?" }] },
      { id: "1", role: "assistant", parts: [{ kind: "text", text: "Two stores." }] },
    ]);
  });
});

function row(over: Partial<InboxRow> & Pick<InboxRow, "id">): InboxRow {
  return {
    kind: "shopper",
    storeId: "s1",
    storeName: "Store 1",
    lastMessageAt: "2026-11-20T10:00:00.000Z",
    messageCount: 2,
    sampled: true,
    reasons: [],
    labels: [],
    firstQuestion: "hi",
    ...over,
  };
}

const NONE = { kind: null, storeId: null, flagged: false, unlabelled: false } as const;

describe("review inbox", () => {
  const rows = orderInbox([
    row({ id: "old-quiet", lastMessageAt: "2026-11-19T10:00:00.000Z" }),
    row({ id: "new-quiet", lastMessageAt: "2026-11-21T10:00:00.000Z", labels: ["tone"] }),
    row({ id: "old-flagged", lastMessageAt: "2026-11-18T10:00:00.000Z", reasons: ["costly_turn"], kind: "copilot", storeId: "s2", storeName: "Store 2" }),
    row({ id: "admin", kind: "admin", storeId: null, storeName: null, lastMessageAt: "2026-11-20T12:00:00.000Z" }),
  ]);

  it("puts flagged chats first, then the sample, newest first", () => {
    expect(rows.map((r) => r.id)).toEqual(["old-flagged", "new-quiet", "admin", "old-quiet"]);
  });

  it("filters by assistant, store, flagged and unlabelled together", () => {
    expect(filterInbox(rows, { ...NONE, kind: "shopper" }).map((r) => r.id)).toEqual(["new-quiet", "old-quiet"]);
    expect(filterInbox(rows, { ...NONE, storeId: "s1", unlabelled: true }).map((r) => r.id)).toEqual(["old-quiet"]);
    expect(filterInbox(rows, { ...NONE, flagged: true }).map((r) => r.id)).toEqual(["old-flagged"]);
    expect(filterInbox(rows, { ...NONE, kind: "admin", storeId: "s1" })).toEqual([]);
  });

  it("counts each option against the other filters, as the subscription filters do", () => {
    const counts = inboxCounts(rows, { ...NONE, kind: "shopper", unlabelled: true });
    expect(counts.kind).toEqual({ all: 3, shopper: 1, copilot: 1, admin: 1 });
    expect(counts.store).toEqual({ all: 1, s1: 1 });
    expect(counts.flagged).toBe(0);
    expect(counts.unlabelled).toBe(1);
  });

  it("moves to the next unlabelled chat after the current one, wrapping, never the current one", () => {
    expect(nextUnlabelled(rows, "copilot:old-flagged")?.id).toBe("admin");
    expect(nextUnlabelled(rows, "shopper:old-quiet")?.id).toBe("old-flagged");
    expect(nextUnlabelled([rows[0]!], chatKey(rows[0]!))).toBeNull();
    expect(nextUnlabelled(rows, "shopper:gone")?.id).toBe("old-flagged");
  });

  it("reads a chat key only for a known assistant", () => {
    expect(parseChatKey("admin:abc")).toEqual({ kind: "admin", id: "abc" });
    expect(parseChatKey("robot:abc")).toBeNull();
    expect(parseChatKey("shopper:")).toBeNull();
    expect(parseChatKey(undefined)).toBeNull();
  });
});
