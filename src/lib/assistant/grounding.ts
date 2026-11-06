import { scrubCardNumbers, scrubKnownStrings } from "./card-scrub";

function scrubToolString(input: string): unknown {
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object") return scrubKnownStrings(parsed);
  } catch {
    // A tool input that is not JSON stays text and is scrubbed as text.
  }
  return scrubCardNumbers(input).text;
}

const PHRASE = "I couldn't confirm that price.";
const LIST_PRICE = "price not confirmed";

/** Decision-5 codes, plus AUD. Matched in either case. Other ISO codes must be capitals or glued to the number. */
const LOOSE_CODES = new Set(["ngn", "ghs", "eur", "gbp", "xof", "cfa", "cad", "aud", "usd"]);
const CODES = new Set(
  `${[...LOOSE_CODES].join(" ")} aed afn all amd ang aoa ars awg azn bam bbd bdt bgn bhd bif bmd bnd bob brl bsd btn bwp byn bzd cdf chf clf clp cny cop crc cup cve czk djf dkk dop dzd egp ern etb fjd fkp gel gip gmd gnf gtq gyd hkd hnl htg huf idr ils inr iqd irr isk jmd jod jpy kes kgs khr kmf kpw krw kwd kyd kzt lak lbp lkr lrd lsl lyd mad mdl mga mkd mmk mnt mop mru mur mvr mwk mxn myr mzn nad nio nok npr nzd omr pab pen pgk php pkr pln pyg qar ron rsd rub rwf sar sbd scr sdg sek sgd shp sle sll sos srd ssp stn svc syp szl thb tjs tmt tnd top try ttd twd tzs uah ugx uyu uzs ves vnd vuv wst xaf xcd xof xpf yer zar zmw zwl`
    .split(/\s+/),
);
const FOREIGN_SYMBOLS = new Set(["€", "£", "₦", "₵", "₹", "¥", "₩", "₽", "₺", "₱", "₫", "₪", "₴", "₡", "৳", "₭", "₮", "₲", "₼"]);
const USD_WORDS = new Set(["dollar", "dollars"]);
const CENT_WORDS = new Set(["cent", "cents"]);
const FOREIGN_WORDS = new Set(["naira", "cedi", "cedis", "euro", "euros", "pound", "pounds"]);
const NUMBER_RE = /^(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?|\.(\d+))/;

const LIST_LINE = /^[ \t]*(?:[-*•][ \t]+|\d+[.)][ \t]+)/;
const TITLES = new Set(["dr", "mr", "mrs", "ms", "st"]);
const CONDITIONAL_ENDS = new Set(["oz", "lb", "lbs", "g", "kg", "ml", "fl", "am", "pm", "us", "no"]);

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
  const tokens = findMoney(text);
  const lines = lineSpans(text);
  let out = "";
  let index = 0;
  while (index < lines.length) {
    let last = index;
    let grew = true;
    while (grew) {
      grew = false;
      const contentEnd = lines[last].contentEnd;
      if (last + 1 < lines.length && tokens.some((token) => token.start < contentEnd && token.end > contentEnd)) {
        last += 1;
        grew = true;
      }
    }
    const start = lines[index].start;
    const end = lines[last].contentEnd;
    const chunk = text.slice(start, end);
    const local = tokens
      .filter((token) => token.start >= start && token.end <= end)
      .map((token) => ({ ...token, start: token.start - start, end: token.end - start }));
    const firstLine = chunk.split("\n")[0] ?? chunk;
    out += LIST_LINE.test(firstLine)
      ? replaceListAmounts(chunk, local, allowedCents, stripped)
      : replaceSentences(chunk, local, allowedCents, stripped);
    out += lines[last].breakAfter;
    index = last + 1;
  }
  return { text: collapsePhrases(out), stripped };
}

interface ParsedNumber {
  end: number;
  whole: string;
  frac: string;
}

function lineSpans(text: string): Array<{ start: number; contentEnd: number; breakAfter: string }> {
  const spans: Array<{ start: number; contentEnd: number; breakAfter: string }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    const contentEnd = index > start && text[index - 1] === "\r" ? index - 1 : index;
    spans.push({ start, contentEnd, breakAfter: "\n" });
    start = index + 1;
  }
  spans.push({ start, contentEnd: text.length, breakAfter: "" });
  return spans;
}

/** Horizontal spaces from JavaScript `\s`, including NBSP. Newlines stay line breaks. */
const HORIZONTAL_SPACE = /[ \t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;

function isHorizontalSpace(char: string | undefined): boolean {
  return char != null && HORIZONTAL_SPACE.test(char);
}

function skipInline(text: string, index: number): number {
  let cursor = index;
  while (isHorizontalSpace(text[cursor])) cursor += 1;
  return cursor;
}

function readWord(text: string, index: number): { raw: string; end: number } | null {
  const match = /^[A-Za-z]+/.exec(text.slice(index));
  if (!match) return null;
  return { raw: match[0], end: index + match[0].length };
}

function readNumber(text: string, index: number): ParsedNumber | null {
  const match = NUMBER_RE.exec(text.slice(index));
  if (!match) return null;
  const whole = (match[1] ?? "0").replace(/,/g, "");
  const frac = match[2] ?? match[3] ?? "";
  if (!/^\d+$/.test(whole) || (frac.length > 0 && !/^\d+$/.test(frac))) return null;
  return { end: index + match[0].length, whole, frac };
}

function dollarCents(num: ParsedNumber): number | null {
  if (num.frac.length > 2) return null;
  const dollars = Number(num.whole);
  if (!Number.isInteger(dollars)) return null;
  if (num.frac.length === 0) return dollars * 100;
  if (num.frac.length === 1) return dollars * 100 + Number(num.frac) * 10;
  return dollars * 100 + Number(num.frac);
}

function centValue(num: ParsedNumber): number | null {
  if (num.frac.length > 0) return null;
  const value = Number(num.whole);
  return Number.isInteger(value) ? value : null;
}

function codeKind(raw: string, glued: boolean): "usd" | "foreign" | null {
  const lower = raw.toLowerCase();
  if (!/^[a-z]{3}$/.test(lower) || !CODES.has(lower)) return null;
  if (!LOOSE_CODES.has(lower) && !glued && raw !== raw.toUpperCase()) return null;
  return lower === "usd" ? "usd" : "foreign";
}

function wordKind(raw: string, glued: boolean): "usd" | "cent" | "foreign" | null {
  const lower = raw.toLowerCase();
  if (USD_WORDS.has(lower)) return "usd";
  if (CENT_WORDS.has(lower)) return "cent";
  if (FOREIGN_WORDS.has(lower)) return "foreign";
  return codeKind(raw, glued);
}

type MarkRole = "usd" | "cent" | "foreign";

interface Atom {
  kind: "number" | "mark";
  start: number;
  end: number;
  role: MarkRole | null;
  whole: string;
  frac: string;
}

/** Empty, horizontal spaces, or one newline. A blank line or a word is not direct. */
function gapDirect(text: string, from: number, to: number): boolean {
  if (to < from) return false;
  let index = from;
  while (isHorizontalSpace(text[index])) index += 1;
  if (index === to) return true;
  if (text[index] === "\r") index += 1;
  if (text[index] !== "\n") return false;
  index += 1;
  if (text[index] === "\n" || text[index] === "\r") return false;
  while (isHorizontalSpace(text[index])) index += 1;
  return index === to;
}

function readMark(text: string, index: number): { end: number; role: MarkRole } | null {
  const symbol = text[index];
  if (symbol === "¢") return { end: index + 1, role: "cent" };
  if (symbol === "$") return { end: index + 1, role: "usd" };
  if (FOREIGN_SYMBOLS.has(symbol)) return { end: index + 1, role: "foreign" };
  const qualified = /^([A-Za-z]{1,3})\$/.exec(text.slice(index));
  if (qualified) {
    const letters = qualified[1].toLowerCase();
    return { end: index + qualified[0].length, role: letters === "us" || letters === "usd" ? "usd" : "foreign" };
  }
  const word = readWord(text, index);
  if (!word) return null;
  if (word.raw.toLowerCase() === "us") {
    const nextAt = skipInline(text, word.end);
    const next = readWord(text, nextAt);
    if (next && USD_WORDS.has(next.raw.toLowerCase()) && gapDirect(text, word.end, nextAt)) {
      return { end: next.end, role: "usd" };
    }
    return null;
  }
  const glued = (index > 0 && /[0-9]/.test(text[index - 1] ?? "")) || /[0-9]/.test(text[word.end] ?? "");
  const kind = wordKind(word.raw, glued);
  if (!kind) return null;
  return { end: word.end, role: kind };
}

function atBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  const current = text[index];
  if (/[A-Za-z]/.test(current) && /[A-Za-z]/.test(prev)) return false;
  if (/[0-9]/.test(current) && /[0-9.,]/.test(prev)) return false;
  return true;
}

function pushToken(text: string, start: number, end: number, cents: number | null, into: MoneyToken[]) {
  if (end <= start) return;
  into.push({ start, end, raw: text.slice(start, end), cents });
}

function tokenize(text: string): Atom[] {
  const atoms: Atom[] = [];
  let index = 0;
  while (index < text.length) {
    if (atBoundary(text, index)) {
      const mark = readMark(text, index);
      if (mark) {
        atoms.push({ kind: "mark", start: index, end: mark.end, role: mark.role, whole: "", frac: "" });
        index = mark.end;
        continue;
      }
      const num = readNumber(text, index);
      if (num) {
        atoms.push({ kind: "number", start: index, end: num.end, role: null, whole: num.whole, frac: num.frac });
        index = num.end;
        continue;
      }
    }
    index += 1;
  }
  return atoms;
}

/** Contiguous marks across a direct gap. A word or a blank line ends the run. */
function markRunEnd(text: string, atoms: Atom[], start: number): number {
  let end = start + 1;
  while (
    end < atoms.length &&
    atoms[end].kind === "mark" &&
    gapDirect(text, atoms[end - 1].end, atoms[end].start)
  ) {
    end += 1;
  }
  return end;
}

/**
 * Each mark binds to one number. A run before a number belongs to that number.
 * A run after a number belongs to it, except the last mark when a number follows:
 * that mark introduces the next number and binds forward alone.
 */
function markOwners(text: string, atoms: Atom[]): Map<number, number> {
  const owner = new Map<number, number>();
  for (let index = 0; index < atoms.length; ) {
    if (atoms[index].kind !== "mark") {
      index += 1;
      continue;
    }
    const runEnd = markRunEnd(text, atoms, index);
    const before = atoms[index - 1];
    const after = atoms[runEnd];
    const prevNumber =
      before?.kind === "number" && gapDirect(text, before.end, atoms[index].start) ? index - 1 : -1;
    const nextNumber =
      after?.kind === "number" && gapDirect(text, atoms[runEnd - 1].end, after.start) ? runEnd : -1;
    if (nextNumber >= 0 && prevNumber >= 0) {
      owner.set(runEnd - 1, nextNumber);
      for (let mark = index; mark < runEnd - 1; mark += 1) owner.set(mark, prevNumber);
    } else if (nextNumber >= 0) {
      for (let mark = index; mark < runEnd; mark += 1) owner.set(mark, nextNumber);
    } else if (prevNumber >= 0) {
      for (let mark = index; mark < runEnd; mark += 1) owner.set(mark, prevNumber);
    }
    index = runEnd;
  }
  return owner;
}

function findMoney(text: string): MoneyToken[] {
  const atoms = tokenize(text);
  const owner = markOwners(text, atoms);
  const tokens: MoneyToken[] = [];
  for (let index = 0; index < atoms.length; index += 1) {
    const number = atoms[index];
    if (number.kind !== "number") continue;
    const marks = atoms.filter((_, markIndex) => owner.get(markIndex) === index);
    if (marks.length === 0) continue;
    const foreign = marks.some((mark) => mark.role === "foreign");
    const cent = marks.some((mark) => mark.role === "cent");
    const usd = marks.some((mark) => mark.role === "usd");
    const parsed = { end: number.end, whole: number.whole, frac: number.frac };
    const cents = foreign || (cent && usd) ? null : cent ? centValue(parsed) : dollarCents(parsed);
    const start = Math.min(number.start, ...marks.map((mark) => mark.start));
    const end = Math.max(number.end, ...marks.map((mark) => mark.end));
    pushToken(text, start, end, cents, tokens);
  }
  return tokens;
}

function allowedToken(token: MoneyToken, allowedCents: Set<number>): boolean {
  return token.cents != null && allowedCents.has(token.cents);
}

function replaceListAmounts(line: string, tokens: MoneyToken[], allowedCents: Set<number>, stripped: string[]): string {
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

function endsOnCapital(text: string, period: number): boolean {
  let cursor = period + 1;
  if (cursor >= text.length || !/\s/.test(text[cursor])) return false;
  while (cursor < text.length && /[ \t]/.test(text[cursor])) cursor += 1;
  if (text[cursor] === "\r") cursor += 1;
  if (text[cursor] === "\n") cursor += 1;
  while (cursor < text.length && /[ \t]/.test(text[cursor])) cursor += 1;
  return /[A-Z]/.test(text[cursor] ?? "");
}

function isSentenceEnd(text: string, index: number, tokens: MoneyToken[]): boolean {
  const ch = text[index];
  if (ch !== "." && ch !== "!" && ch !== "?") return false;
  if (tokens.some((token) => index >= token.start && index < token.end)) return false;
  if (ch === ".") {
    const before = text.slice(0, index);
    if (/\d$/.test(before) && /\d/.test(text[index + 1] ?? "")) return false;
    const word = /([A-Za-z]+)$/.exec(before);
    if (word) {
      const lower = word[1].toLowerCase();
      if (word[1].length === 1 || TITLES.has(lower)) return false;
      if (CONDITIONAL_ENDS.has(lower)) return endsOnCapital(text, index);
    }
  }
  const next = text[index + 1];
  return next === undefined || /\s/.test(next);
}

function replaceSentences(line: string, tokens: MoneyToken[], allowedCents: Set<number>, stripped: string[]): string {
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
            const original = buffers.get(id) ?? "";
            const grounded = groundAmounts(original, allowed);
            const emitted = scrubCardNumbers(grounded.text).text;
            buffers.delete(id);
            for (const amount of grounded.stripped) options.onStrip?.(amount);
            if (emitted) {
              controller.enqueue({ type: "text-delta", id, text: emitted });
            }
            controller.enqueue(part);
            return;
          }
          if (type === "tool-call") {
            const input = (part as { input?: unknown }).input;
            const scrubbed = typeof input === "string" ? scrubToolString(input) : scrubKnownStrings(input ?? {});
            controller.enqueue({ ...part, input: scrubbed });
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
