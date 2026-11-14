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

/** A turn above $0.02 is flagged; a Haiku turn usually costs about a tenth of a cent. */
export const TURN_COST_FLAG_MICROS = 20_000;

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

/** The auto-flag reasons one stored assistant action raises, in FLAG_REASONS order. */
export function actionFlagReasons(action: ReviewedAction): FlagReason[] {
  const output = record(action.output) ?? {};
  const reasons = new Set<FlagReason>();
  if (action.tool === "grounding_strip") reasons.add("amount_removed");
  if (action.tool === "forward_to_store") reasons.add("forwarded");
  if (action.tool === "turn_cost") {
    const cost = output.costMicros;
    if (typeof cost === "number" && cost > TURN_COST_FLAG_MICROS) reasons.add("costly_turn");
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
  role: "shopper" | "owner" | "assistant";
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

/** The stored copilot transcript as reviewable parts. */
export function copilotTranscript(messages: unknown): TranscriptMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: TranscriptMessage[] = [];
  messages.forEach((raw, index) => {
    const message = record(raw);
    const role = message?.role;
    const text = str(message?.text);
    if (!message || (role !== "owner" && role !== "assistant") || text === null) return;
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
