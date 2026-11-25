import { HISTORY_MAX, LISTING_GAPS, isProposalKind, type ChoiceCandidate, type ListingChoice, type ListingFix, type ListingGap } from "./types";

export interface StoredMessage {
  role: "owner" | "assistant";
  text: string;
  /** The owner's client message id for the turn this reply answers. */
  messageId?: string;
  choices?: ListingChoice[];
  /** Listings this reply said need fixing (#820). */
  fixes?: ListingFix[];
  /** What this reply cost, for AI oversight (#544). Never sent to the panel. */
  costMicros?: number;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseChoice(value: unknown): ListingChoice | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const kind = str(item.kind);
  const createdAt = str(item.createdAt);
  const expiresAt = str(item.expiresAt);
  if (!kind || !isProposalKind(kind) || !createdAt || !expiresAt || !Array.isArray(item.candidates)) return null;
  const candidates: ChoiceCandidate[] = [];
  for (const candidate of item.candidates) {
    const listingId = str((candidate as { listingId?: unknown } | null)?.listingId);
    const name = str((candidate as { name?: unknown } | null)?.name);
    if (listingId && name) candidates.push({ listingId, name });
  }
  if (candidates.length === 0) return null;
  return {
    candidates,
    kind,
    quantity: typeof item.quantity === "number" ? item.quantity : null,
    statusValue: str(item.statusValue),
    nearOnly: item.nearOnly === true,
    createdAt,
    expiresAt,
  };
}

function parseFix(value: unknown): ListingFix | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const listingId = str(item.listingId);
  const name = str(item.name);
  const href = str(item.href);
  const missing = Array.isArray(item.missing)
    ? item.missing.filter((gap): gap is ListingGap => (LISTING_GAPS as readonly unknown[]).includes(gap))
    : [];
  if (!listingId || !name || !href?.startsWith("/store-admin/listings?") || missing.length === 0) return null;
  return { listingId, name, missing, href };
}

export function parseStoredMessages(value: unknown): StoredMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: StoredMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const text = (item as { text?: unknown }).text;
    if ((role !== "owner" && role !== "assistant") || typeof text !== "string") continue;
    const messageId = str((item as { messageId?: unknown }).messageId);
    const costMicros = (item as { costMicros?: unknown }).costMicros;
    const rawChoices = (item as { choices?: unknown }).choices;
    const choices = Array.isArray(rawChoices)
      ? rawChoices.map(parseChoice).filter((choice): choice is ListingChoice => choice !== null)
      : [];
    const rawFixes = (item as { fixes?: unknown }).fixes;
    const fixes = Array.isArray(rawFixes) ? rawFixes.map(parseFix).filter((fix): fix is ListingFix => fix !== null) : [];
    messages.push({
      role,
      text,
      ...(messageId ? { messageId } : {}),
      ...(choices.length > 0 ? { choices } : {}),
      ...(fixes.length > 0 ? { fixes } : {}),
      ...(typeof costMicros === "number" && Number.isFinite(costMicros) ? { costMicros } : {}),
    });
  }
  return messages;
}

/** The last 20 stored turns, starting at an owner message so a pair is never split. */
export function modelHistory(messages: readonly StoredMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const recent = messages.slice(-HISTORY_MAX);
  const start = recent.findIndex((message) => message.role === "owner");
  if (start < 0) return [];
  return recent.slice(start).map((message) => ({
    role: message.role === "owner" ? "user" : "assistant",
    content: message.text,
  }));
}
