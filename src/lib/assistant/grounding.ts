const PHRASE = "I couldn't confirm that price.";
const LIST_PRICE = "price not confirmed";

const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const INTEGER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)`;
const FOREIGN_CODES = "NGN|GHS|EUR|GBP|XOF|CFA|CAD";

/**
 * Non-USD forms come first so `CAD $10.99` is one token, not an allowed dollar amount.
 * 3+ decimal places stay inside the token and are rejected whole.
 */
const MONEY_SOURCE = [
  String.raw`\b(?:${FOREIGN_CODES})\s+\$?\s?${NUMBER}`,
  String.raw`(?:US\$|\$)\s?${NUMBER}\s+(?:${FOREIGN_CODES})\b`,
  String.raw`${NUMBER}\s+(?:${FOREIGN_CODES})\b`,
  String.raw`[€£₦₵₹¥]\s?${NUMBER}`,
  String.raw`\bUSD\s+${NUMBER}`,
  String.raw`US\$\s?${NUMBER}`,
  String.raw`\$\s?${NUMBER}`,
  String.raw`${NUMBER}\s+USD\b`,
  String.raw`${NUMBER}\s+dollars\b`,
  String.raw`${INTEGER}\s*¢`,
  String.raw`${INTEGER}\s+cents\b`,
].join("|");

const LIST_LINE = /^[ \t]*(?:[-*•][ \t]+|\d+[.)][ \t]+)/;
const ABBREVIATIONS = new Set([
  "oz", "lb", "lbs", "g", "kg", "ml", "fl", "dr", "mr", "mrs", "ms", "st",
  "etc", "vs", "no", "vol", "eg", "ie", "jr", "sr", "am", "pm", "us",
]);

const UNIT_PRICE_FIELDS = ["priceCents", "unitPriceCents"] as const;

export interface KeyedUnitPrice {
  key: string;
  cents: number;
}

interface MoneyToken {
  start: number;
  end: number;
  raw: string;
  cents: number | null;
}

export function groundAmounts(
  text: string,
  allowedCents: Set<number>,
): { text: string; stripped: string[] } {
  const stripped: string[] = [];
  const lines = text.split("\n");
  const next = lines.map((line) =>
    LIST_LINE.test(line)
      ? replaceListAmounts(line, allowedCents, stripped)
      : replaceSentences(line, allowedCents, stripped),
  );
  return { text: collapsePhrases(next.join("\n")), stripped };
}

function amountToCents(match: string): number | null {
  const body = match
    .replace(/US\$|USD|dollars/gi, "")
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();
  const [whole, frac = ""] = body.split(".");
  if (frac.length > 2) return null;
  if (!/^\d+$/.test(whole)) return null;
  const dollars = Number(whole);
  if (!Number.isInteger(dollars)) return null;
  if (frac.length === 0) return dollars * 100;
  if (!/^\d+$/.test(frac)) return null;
  if (frac.length === 1) return dollars * 100 + Number(frac) * 10;
  return dollars * 100 + Number(frac);
}

function isForeign(raw: string): boolean {
  return new RegExp(String.raw`[€£₦₵₹¥]|\b(?:${FOREIGN_CODES})\b`, "i").test(raw);
}

function tokenToCents(raw: string): number | null {
  if (isForeign(raw)) return null;
  const cents = raw.match(new RegExp(String.raw`(${INTEGER})\s*(?:¢|cents\b)`, "i"));
  if (cents && !raw.includes("$") && !/USD/i.test(raw)) {
    const value = Number(cents[1].replace(/,/g, ""));
    return Number.isInteger(value) ? value : null;
  }
  return amountToCents(raw);
}

function findMoney(text: string): MoneyToken[] {
  const re = new RegExp(MONEY_SOURCE, "gi");
  const tokens: MoneyToken[] = [];
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    const start = match.index ?? 0;
    tokens.push({ start, end: start + raw.length, raw, cents: tokenToCents(raw) });
  }
  return tokens;
}

function allowedToken(token: MoneyToken, allowedCents: Set<number>): boolean {
  return token.cents != null && allowedCents.has(token.cents);
}

function replaceListAmounts(line: string, allowedCents: Set<number>, stripped: string[]): string {
  const tokens = findMoney(line);
  if (tokens.length === 0) return line;
  let out = "";
  let cursor = 0;
  for (const token of tokens) {
    out += line.slice(cursor, token.start);
    if (allowedToken(token, allowedCents)) out += token.raw;
    else {
      stripped.push(token.raw);
      out += LIST_PRICE;
    }
    cursor = token.end;
  }
  return out + line.slice(cursor);
}

function isSentenceEnd(text: string, index: number, tokens: MoneyToken[]): boolean {
  const ch = text[index];
  if (ch !== "." && ch !== "!" && ch !== "?") return false;
  if (tokens.some((token) => index >= token.start && index < token.end)) return false;
  if (ch === ".") {
    const before = text.slice(0, index);
    if (/\d$/.test(before) && /\d/.test(text[index + 1] ?? "")) return false;
    const word = /([A-Za-z]+)$/.exec(before);
    if (word && (word[1].length === 1 || ABBREVIATIONS.has(word[1].toLowerCase()))) return false;
  }
  const next = text[index + 1];
  return next === undefined || /\s/.test(next);
}

function replaceSentences(line: string, allowedCents: Set<number>, stripped: string[]): string {
  const tokens = findMoney(line);
  if (tokens.length === 0) return line;
  const ends: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    if (isSentenceEnd(line, index, tokens)) ends.push(index + 1);
  }
  const pieces: string[] = [];
  let cursor = 0;
  for (const end of [...ends, line.length]) {
    if (end <= cursor) continue;
    const slice = line.slice(cursor, end);
    const bad = tokens.filter(
      (token) => token.start >= cursor && token.end <= end && !allowedToken(token, allowedCents),
    );
    if (bad.length === 0) {
      pieces.push(slice);
    } else {
      for (const token of bad) stripped.push(token.raw);
      const lead = /^[ \t]*/.exec(slice)?.[0] ?? "";
      pieces.push(`${lead}${PHRASE}`);
    }
    cursor = end;
  }
  return pieces.join("");
}

function collapsePhrases(text: string): string {
  const escaped = PHRASE.replace(/[.]/g, "\\.");
  const pair = new RegExp(`${escaped}(?:[ \\t]*\\n+[ \\t]*|[ \\t]+)${escaped}`, "g");
  let prev = "";
  let next = text;
  while (next !== prev) {
    prev = next;
    next = next.replace(pair, PHRASE);
  }
  return next;
}

export function collectAllowedCents(value: unknown, into = new Set<number>()): Set<number> {
  if (Array.isArray(value)) {
    for (const item of value) collectAllowedCents(item, into);
    return into;
  }
  if (!value || typeof value !== "object") return into;
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("Cents") && typeof child === "number" && Number.isInteger(child)) {
      into.add(child);
    }
    collectAllowedCents(child, into);
  }
  return into;
}

function priceKey(record: Record<string, unknown>): string | null {
  const variantId = record.variantId;
  if (typeof variantId === "string" && variantId.length > 0) return `variant:${variantId}`;
  if (variantId == null) {
    const listingId = record.listingId;
    if (typeof listingId === "string" && listingId.length > 0) return `listing:${listingId}`;
  }
  return null;
}

/** Keyed `priceCents` / `unitPriceCents` only. Other `*Cents` fields are not unit prices. */
export function collectKeyedUnitPrices(value: unknown, into: KeyedUnitPrice[] = []): KeyedUnitPrice[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeyedUnitPrices(item, into);
    return into;
  }
  if (!value || typeof value !== "object") return into;
  const record = value as Record<string, unknown>;
  const key = priceKey(record);
  if (key) {
    for (const field of UNIT_PRICE_FIELDS) {
      const child = record[field];
      if (typeof child === "number" && Number.isInteger(child)) into.push({ key, cents: child });
    }
  }
  for (const child of Object.values(record)) collectKeyedUnitPrices(child, into);
  return into;
}

export interface HistoryMessage {
  role: string;
  parts: readonly HistoryPart[];
}

export interface HistoryPart {
  type: string;
  state?: string;
  output?: unknown;
}

/** Unit prices from assistant tool outputs in the history the model is about to see. */
export function keyedUnitPricesFromHistory(messages: readonly HistoryMessage[]): KeyedUnitPrice[] {
  const into: KeyedUnitPrice[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!part.type.startsWith("tool-") || part.state !== "output-available") continue;
      collectKeyedUnitPrices(part.output, into);
    }
  }
  return into;
}

export interface GroundingTransformOptions {
  onStrip?: (amount: string) => void;
  /** Always-allowed cents for this request, such as the store minimum. Not shared across requests. */
  getAllowedCents?: () => Set<number>;
  /** Oldest-first keyed unit prices from validated history. The newest price per key wins. */
  historyUnitPrices?: readonly KeyedUnitPrice[];
}

/**
 * Buffers each text block and grounds it before any of that block is emitted.
 * Tool and other parts pass through immediately. One instance covers every step of a turn.
 */
export function groundingTransform(options: GroundingTransformOptions = {}) {
  return () => {
    const baseline = new Set<number>(options.getAllowedCents?.() ?? []);
    const newest = new Map<string, number>();
    for (const price of options.historyUnitPrices ?? []) newest.set(price.key, price.cents);
    const thisTurn = new Set<number>();
    const buffers = new Map<string, string>();

    const allowedNow = () => {
      const allowed = new Set<number>(baseline);
      for (const cents of newest.values()) allowed.add(cents);
      for (const cents of thisTurn) allowed.add(cents);
      return allowed;
    };

    let allowed = allowedNow();
    return new TransformStream({
      transform(part, controller) {
        if (part && typeof part === "object" && "type" in part) {
          const type = (part as { type: string }).type;
          const id = String((part as { id?: string }).id ?? "");
          if (type === "tool-result") {
            const output = (part as { output?: unknown }).output;
            collectAllowedCents(output, thisTurn);
            for (const price of collectKeyedUnitPrices(output)) newest.set(price.key, price.cents);
            allowed = allowedNow();
          }
          if (type === "text-start") {
            buffers.set(id, "");
            controller.enqueue(part);
            return;
          }
          if (type === "text-delta" && buffers.has(id)) {
            const piece = part as { text?: string; delta?: string };
            buffers.set(id, `${buffers.get(id) ?? ""}${piece.text ?? piece.delta ?? ""}`);
            return;
          }
          if (type === "text-end" && buffers.has(id)) {
            const grounded = groundAmounts(buffers.get(id) ?? "", allowed);
            buffers.delete(id);
            for (const amount of grounded.stripped) options.onStrip?.(amount);
            if (grounded.text) {
              controller.enqueue({ type: "text-delta", id, text: grounded.text });
            }
            controller.enqueue(part);
            return;
          }
          if (type === "error") {
            if (id && buffers.has(id)) buffers.delete(id);
            else buffers.clear();
            controller.enqueue(part);
            return;
          }
        }
        controller.enqueue(part);
      },
    });
  };
}
