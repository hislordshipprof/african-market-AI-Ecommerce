/** AI oversight (#544): review labels, auto-flag reasons and transcript shapes. No database access here. */

export const REVIEW_LABELS = ["wrong_item", "wrong_price", "unsafe", "tone", "other"] as const;
export type ReviewLabel = (typeof REVIEW_LABELS)[number];

export const REVIEW_LABEL_TEXT: Record<ReviewLabel, string> = {
  wrong_item: "Wrong item",
  wrong_price: "Wrong price",
  unsafe: "Unsafe",
  tone: "Tone",
  other: "Other",
};

export const FLAG_REASONS = ["amount_removed", "made_up_id", "needs_refusal", "forwarded", "costly_turn"] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

export const FLAG_REASON_TEXT: Record<FlagReason, string> = {
  amount_removed: "Price removed",
  made_up_id: "Made-up id refused",
  needs_refusal: "Needs refusal",
  forwarded: "Forwarded to store",
  costly_turn: "Costly turn",
};

/** Codes a tool returns when the model named an id that is not in this store or this cart. */
const MADE_UP_ID_CODES = new Set(["variant_not_found", "line_not_found", "listing_not_found", "not_shown"]);
/** Codes a tool returns when the shopper's saved needs refused an item. */
const NEEDS_CODES = new Set(["excluded", "cannot_confirm", "unchecked_swap"]);

export interface ReviewedAction {
  tool: string;
  ok: boolean;
  output: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function outputCodes(output: Record<string, unknown>): string[] {
  const codes = typeof output.code === "string" ? [output.code] : [];
  if (Array.isArray(output.items)) {
    for (const item of output.items) {
      const code = record(item)?.code;
      if (typeof code === "string") codes.push(code);
    }
  }
  return codes;
}

/**
 * The auto-flag reasons one stored assistant action raises, in FLAG_REASONS order. The cost threshold is the platform
 * setting (#561), read by the caller.
 */
export function actionFlagReasons(action: ReviewedAction, costFlagMicros: number): FlagReason[] {
  const output = record(action.output) ?? {};
  const reasons = new Set<FlagReason>();
  if (action.tool === "grounding_strip") reasons.add("amount_removed");
  if (action.tool === "forward_to_store") reasons.add("forwarded");
  if (action.tool === "turn_cost") {
    const cost = output.costMicros;
    if (typeof cost === "number" && cost > costFlagMicros) reasons.add("costly_turn");
  }
  const codes = outputCodes(output);
  if (codes.some((code) => MADE_UP_ID_CODES.has(code)) || nonEmptyArray(output.notFound)) reasons.add("made_up_id");
  if (codes.some((code) => NEEDS_CODES.has(code)) || nonEmptyArray(output.excluded)) reasons.add("needs_refusal");
  return FLAG_REASONS.filter((reason) => reasons.has(reason));
}

export type TranscriptPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; input: unknown; output: unknown }
  | { kind: "attachment"; name: string; mediaType: string; bytes: number | null; pages: number | null }
  | { kind: "choices"; names: string[] }
  | { kind: "data"; type: string; data: unknown };

export interface TranscriptMessage {
  id: string;
  role: "shopper" | "owner" | "admin" | "assistant";
  parts: TranscriptPart[];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A stored attachment is a descriptor only; any other field is dropped so no file content can be shown. */
function attachmentPart(data: unknown): TranscriptPart {
  const descriptor = record(data) ?? {};
  return {
    kind: "attachment",
    name: str(descriptor.name) ?? "file",
    mediaType: str(descriptor.mediaType) ?? "unknown",
    bytes: num(descriptor.bytes),
    pages: num(descriptor.pages),
  };
}

function shopperPart(raw: unknown): TranscriptPart | null {
  const part = record(raw);
  const type = str(part?.type);
  if (!part || !type) return null;
  if (type === "text") return { kind: "text", text: str(part.text) ?? "" };
  if (type === "data-attachment") return attachmentPart(part.data);
  if (type.startsWith("tool-")) return { kind: "tool", tool: type.slice(5), input: part.input ?? null, output: part.output ?? null };
  if (type.startsWith("data-")) return { kind: "data", type: type.slice(5), data: part.data ?? null };
  return null;
}

/** The stored shopper transcript (AI SDK UI messages) as reviewable parts. Reasoning and step markers are left out. */
export function shopperTranscript(messages: unknown): TranscriptMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: TranscriptMessage[] = [];
  messages.forEach((raw, index) => {
    const message = record(raw);
    const role = message?.role;
    if (!message || (role !== "user" && role !== "assistant") || !Array.isArray(message.parts)) return;
    out.push({
      id: str(message.id) ?? String(index),
      role: role === "user" ? "shopper" : "assistant",
      parts: message.parts.map(shopperPart).filter((part): part is TranscriptPart => part !== null),
    });
  });
  return out;
}

/** The stored copilot or platform admin assistant transcript as reviewable parts; both store { role, text } turns. */
export function copilotTranscript(messages: unknown, asker: "owner" | "admin" = "owner"): TranscriptMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: TranscriptMessage[] = [];
  messages.forEach((raw, index) => {
    const message = record(raw);
    const role = message?.role;
    const text = str(message?.text);
    if (!message || (role !== asker && role !== "assistant") || text === null) return;
    const parts: TranscriptPart[] = [{ kind: "text", text }];
    if (Array.isArray(message.choices)) {
      for (const choice of message.choices) {
        const candidates = record(choice)?.candidates;
        const names = Array.isArray(candidates)
          ? candidates.map((candidate) => str(record(candidate)?.name)).filter((name): name is string => !!name)
          : [];
        if (names.length > 0) parts.push({ kind: "choices", names });
      }
    }
    out.push({ id: String(index), role, parts });
  });
  return out;
}

/** The three assistants whose chats are reviewed: shopper, store copilot and platform admin (#856). */
export const CONVERSATION_KINDS = ["shopper", "copilot", "admin"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const KIND_TEXT: Record<ConversationKind, string> = { shopper: "Shopper", copilot: "Store", admin: "Platform admin" };

export interface InboxRow {
  kind: ConversationKind;
  id: string;
  /** Null for a platform admin assistant chat, which belongs to no store. */
  storeId: string | null;
  storeName: string | null;
  lastMessageAt: string;
  messageCount: number;
  sampled: boolean;
  reasons: FlagReason[];
  labels: ReviewLabel[];
  /** The first thing the shopper, owner or admin asked, cut to 200 characters. */
  firstQuestion: string;
}

export interface InboxFilters {
  kind: ConversationKind | null;
  storeId: string | null;
  flagged: boolean;
  unlabelled: boolean;
}

export function chatKey(row: Pick<InboxRow, "kind" | "id">): string {
  return `${row.kind}:${row.id}`;
}

export function parseChatKey(value: string | undefined): { kind: ConversationKind; id: string } | null {
  const at = value?.indexOf(":") ?? -1;
  if (!value || at < 0) return null;
  const kind = CONVERSATION_KINDS.find((known) => known === value.slice(0, at));
  const id = value.slice(at + 1);
  return kind && id ? { kind, id } : null;
}

/** Flagged chats first, then the sample, newest first. */
export function orderInbox(rows: InboxRow[]): InboxRow[] {
  return rows.sort((a, b) =>
    Number(b.reasons.length > 0) - Number(a.reasons.length > 0)
    || b.lastMessageAt.localeCompare(a.lastMessageAt)
    || chatKey(a).localeCompare(chatKey(b)));
}

function matches(row: InboxRow, filters: InboxFilters, skip?: keyof InboxFilters): boolean {
  return (skip === "kind" || !filters.kind || row.kind === filters.kind)
    && (skip === "storeId" || !filters.storeId || row.storeId === filters.storeId)
    && (skip === "flagged" || !filters.flagged || row.reasons.length > 0)
    && (skip === "unlabelled" || !filters.unlabelled || row.labels.length === 0);
}

export function filterInbox(rows: InboxRow[], filters: InboxFilters): InboxRow[] {
  return rows.filter((row) => matches(row, filters));
}

/** Each option's count under the other active filters, so a count is what choosing it would show (#837). */
export function inboxCounts(rows: InboxRow[], filters: InboxFilters) {
  const kind: Record<"all" | ConversationKind, number> = { all: 0, shopper: 0, copilot: 0, admin: 0 };
  const store: Record<string, number> = { all: 0 };
  let flagged = 0;
  let unlabelled = 0;
  for (const row of rows) {
    if (matches(row, filters, "kind")) {
      kind.all += 1;
      kind[row.kind] += 1;
    }
    if (matches(row, filters, "storeId")) {
      store.all += 1;
      if (row.storeId) store[row.storeId] = (store[row.storeId] ?? 0) + 1;
    }
    if (matches(row, filters, "flagged") && row.reasons.length > 0) flagged += 1;
    if (matches(row, filters, "unlabelled") && row.labels.length === 0) unlabelled += 1;
  }
  return { kind, store, flagged, unlabelled };
}

/** The first unlabelled chat after the current one in list order, wrapping round; never the current one. */
export function nextUnlabelled(rows: InboxRow[], current: string): InboxRow | null {
  const at = rows.findIndex((row) => chatKey(row) === current);
  const rotated = [...rows.slice(at + 1), ...rows.slice(0, Math.max(at, 0))];
  return rotated.find((row) => row.labels.length === 0 && chatKey(row) !== current) ?? null;
}

/** Where a chat opens in the review inbox. */
export function conversationHref(kind: ConversationKind, id: string): string {
  return `/admin/ai/conversations?chat=${encodeURIComponent(`${kind}:${id}`)}`;
}
