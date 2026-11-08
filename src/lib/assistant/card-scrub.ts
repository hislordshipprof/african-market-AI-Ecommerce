/** Luhn check. `digits` is ASCII 0-9 only. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function windowPasses(digits: string): boolean {
  if (digits.length >= 13 && digits.length <= 19) return luhnValid(digits);
  if (digits.length < 13) return false;
  for (let length = 13; length <= 19; length += 1) {
    for (let start = 0; start + length <= digits.length; start += 1) {
      if (luhnValid(digits.slice(start, start + length))) return true;
    }
  }
  return false;
}

/**
 * Mask Luhn-valid card numbers. The whole run is replaced, including separators,
 * so no digits of the number remain.
 */
export function scrubCardNumbers(text: string): { text: string; removed: number } {
  const normalized = text.normalize("NFKC");
  let removed = 0;
  let out = "";
  let i = 0;
  while (i < normalized.length) {
    if (!isDigit(normalized, i)) {
      out += normalized[i];
      i += 1;
      continue;
    }
    const start = i;
    let digits = "";
    while (i < normalized.length) {
      if (isDigit(normalized, i)) {
        digits += normalized[i];
        i += 1;
        continue;
      }
      const separator = normalized[i];
      if ((separator === " " || separator === "-") && isDigit(normalized, i + 1)) {
        i += 1;
        continue;
      }
      break;
    }
    if (windowPasses(digits)) {
      out += "[card number removed]";
      removed += 1;
    } else {
      out += normalized.slice(start, i);
    }
  }
  return { text: out, removed };
}

/** In a filename any punctuation, space or symbol can split a number. A letter ends it. */
const NAME_DIGIT_RUN = /\d(?:[^\p{L}\p{N}]*\d)*/gu;
const CAMERA_DATE = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;
const CAMERA_TIME = /^(?:[01]\d|2[0-3])[0-5]\d[0-5]\d(?:\d{3})?$/;

/**
 * How many leading digit groups are a camera's date and time (`IMG_20240115_000000`,
 * `2024-01-15 00.00.00`). No card is written in that grouping or starts 19 or 20 at
 * that length, and about 1 in 10 such names would pass Luhn.
 */
function cameraStampGroups(groups: string[]): number {
  const [date = "", time = ""] = groups;
  if (CAMERA_DATE.test(date) && CAMERA_TIME.test(time)) return 2;
  const parts = groups.slice(0, 6);
  const grouped = parts.map((part) => part.length).join() === "4,2,2,2,2,2";
  if (grouped && CAMERA_DATE.test(parts.slice(0, 3).join("")) && CAMERA_TIME.test(parts.slice(3).join(""))) return 6;
  return 0;
}

function runHoldsCard(run: string): boolean {
  const all = run.match(/\d+/g) ?? [];
  const groups = all.slice(cameraStampGroups(all));
  for (let start = 0; start < groups.length; start += 1) {
    if ((groups[start]?.length ?? 0) > 19 && windowPasses(groups[start] ?? "")) return true;
    let digits = "";
    for (let end = start; end < groups.length && digits.length <= 19; end += 1) {
      digits += groups[end];
      if (luhnValid(digits)) return true;
    }
  }
  return false;
}

/**
 * Card numbers in a filename, where the digits can be split by anything but a letter
 * and a suffix such as " (1)" can follow them. Candidates start and end on digit groups.
 * The whole run is replaced.
 */
export function scrubFileNameCards(name: string): { text: string; removed: number } {
  let removed = 0;
  const text = name.normalize("NFKC").replace(NAME_DIGIT_RUN, (run) => {
    if (!runHoldsCard(run)) return run;
    removed += 1;
    return "[card number removed]";
  });
  return { text, removed };
}

function isDigit(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 48 && code <= 57;
}

/** Ids and tool-call handles are opaque. Scrubbing them would change a different record. */
const OPAQUE_KEYS = new Set([
  "id",
  "listingId",
  "variantId",
  "lineId",
  "toolCallId",
  "conversationId",
  "storeId",
  "cartId",
  "additionId",
  "choiceId",
  "listing_id",
  "variant_id",
  "line_id",
  "_turn",
  "_call",
]);

/**
 * A scalar id is not rewritten unless it is itself a card number.
 * A container under an opaque key is still walked, so a rejected tool
 * input cannot hide a card number inside an object or array.
 */
function keepOpaque(value: unknown): unknown {
  if (typeof value === "string") {
    const scrubbed = scrubCardNumbers(value).text;
    return scrubbed === value ? value : scrubbed;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && luhnValid(String(value))) {
    return "[card number removed]";
  }
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) || (value !== null && typeof value === "object")) {
    return scrubKnownStrings(value);
  }
  return value;
}

/**
 * A card number used as a property name is renamed. A second one in the same
 * object gets " (2)", then " (3)", so the digits are not kept to tell them apart.
 * A name that is not a card number stays as it was written.
 */
function scrubbedKey(key: string, used: Record<string, unknown>): string {
  const scrubbed = scrubCardNumbers(key);
  const name = scrubbed.removed > 0 ? scrubbed.text : key;
  if (!Object.prototype.hasOwnProperty.call(used, name)) return name;
  let n = 2;
  while (Object.prototype.hasOwnProperty.call(used, `${name} (${n})`)) n += 1;
  return `${name} (${n})`;
}

/** Card numbers in customer-visible or audited strings. Scalar opaque ids stay as they are. */
export function scrubKnownStrings(value: unknown): unknown {
  if (typeof value === "string") return scrubCardNumbers(value).text;
  if (typeof value === "number" && Number.isSafeInteger(value) && luhnValid(String(value))) {
    return "[card number removed]";
  }
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map((item) => scrubKnownStrings(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const name = scrubbedKey(key, out);
    out[name] = OPAQUE_KEYS.has(key) ? keepOpaque(child) : scrubKnownStrings(child);
  }
  return out;
}
