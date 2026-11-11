import { projectStorefrontListing } from "../storefront/service";
import { replyStatus } from "./replay";

/** Phrases the owner settled. Longer phrases are matched first. */
const ACCEPTANCE_PHRASES = [
  "add what you suggested",
  "go ahead",
  "add those",
  "okay",
  "sure",
  "yes",
  "ok",
] as const;

const GENERIC_TOKENS = new Set([
  "rice", "oil", "pepper", "paste", "seasoning", "cube", "powder", "flour",
  "leaf", "leave", "pack", "packet", "tin", "bag", "bottle", "jar", "fresh",
  "dried", "ground", "whole", "red", "the", "of", "and", "with", "in", "a",
]);

export interface AcceptanceTurn {
  led: boolean;
  customerText: string;
  lastReplyText: string;
  lastReplyEmpty: boolean;
}

export interface ShownPart {
  type: string;
  text?: string;
  state?: string;
  toolName?: string;
  output?: unknown;
}

export interface ShownMessage {
  role: string;
  id?: string;
  metadata?: unknown;
  parts: readonly ShownPart[];
}

export interface ListingNameSource {
  customName: string | null;
  price: number;
  confidence: number;
  stockMode: string;
  qty: number | null;
  status: string | null;
  frozen: boolean;
  perishable: boolean;
  masterProduct: { name: string; imageUrl?: string | null } | null;
  variants: { id: string; label: string; price: number; weightG: number }[];
}

export function isAcceptanceLed(text: string): boolean {
  const folded = text.normalize("NFKC").toLowerCase();
  const trimmed = folded.replace(/^(?:[\s\p{P}\p{S}]+)/u, "");
  return ACCEPTANCE_PHRASES.some((phrase) => {
    if (!trimmed.startsWith(phrase)) return false;
    const next = trimmed.charAt(phrase.length);
    return next === "" || !/^[\p{L}\p{N}]$/u.test(next);
  });
}

export function namesForListing(listing: ListingNameSource): string[] {
  const projected = projectStorefrontListing({
    id: "shown",
    customName: listing.customName,
    price: listing.price,
    confidence: listing.confidence,
    stockMode: listing.stockMode,
    qty: listing.qty,
    status: listing.status,
    frozen: listing.frozen,
    perishable: listing.perishable,
    masterProduct: listing.masterProduct,
    variants: listing.variants,
  });
  const names = [projected.displayName, projected.altName, listing.masterProduct?.name];
  return [...new Set(names.filter((name): name is string => typeof name === "string" && name.trim() !== ""))];
}

/** Every distinctive token of a listing name appears in the text, or the whole head does. */
export function textNamesProduct(text: string, names: readonly string[]): boolean {
  const haystack = tokensOf(text);
  const present = new Set(haystack);
  for (const name of names) {
    const head = tokensOf(name.replace(/\([^)]*\)/g, " "));
    const distinctive = head.filter((token) => !/\d/.test(token) && !GENERIC_TOKENS.has(token));
    if (distinctive.length === 0) {
      if (head.length > 0 && containsRun(haystack, head)) return true;
      continue;
    }
    if (distinctive.every((token) => present.has(token))) return true;
  }
  return false;
}

export function acceptanceForTurn(
  messages: readonly ShownMessage[],
  userMessageId: string,
  customerText: string,
): AcceptanceTurn {
  const index = messages.findIndex((message) => message.role === "user" && message.id === userMessageId);
  let previous: ShownMessage | undefined;
  if (index >= 0) {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor]?.role === "assistant") {
        previous = messages[cursor];
        break;
      }
    }
  }
  return {
    led: isAcceptanceLed(customerText),
    customerText,
    lastReplyText: previous ? textOf(previous) : "",
    lastReplyEmpty: !previous || replyCountsAsEmpty(previous),
  };
}

export function replyCountsAsEmpty(message: ShownMessage): boolean {
  if (replyStatus(message) === "failed") return true;
  return message.parts.some((part) => {
    const name = toolNameOf(part);
    if (!name || !outputOk(part.output)) return false;
    if (name === "offer_choices") return true;
    return name === "add_to_cart" && addOutputAdded(part.output);
  });
}

function textOf(message: ShownMessage): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

function toolNameOf(part: ShownPart): string | null {
  if (part.type === "dynamic-tool") return typeof part.toolName === "string" ? part.toolName : null;
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return null;
}

function outputOk(output: unknown): boolean {
  return !!output && typeof output === "object" && (output as { ok?: unknown }).ok === true;
}

function addOutputAdded(output: unknown): boolean {
  if (!outputOk(output)) return false;
  const body = output as { added?: unknown; items?: unknown };
  if (typeof body.added === "number" && body.added > 0) return true;
  if (!Array.isArray(body.items)) return false;
  return body.items.some((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as { ok?: unknown; added?: unknown };
    return row.ok === true && typeof row.added === "number" && row.added > 0;
  });
}

function tokensOf(text: string): string[] {
  const stripped = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const spaced = stripped.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!spaced) return [];
  return spaced.split(/\s+/).map((token) => (
    /^[\p{L}]{4,}$/u.test(token) && token.endsWith("s") ? token.slice(0, -1) : token
  ));
}

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}
