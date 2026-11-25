/** The search box's combobox logic (#835), apart from the component so it can be tested. */

export interface CompletionPart {
  text: string;
  bold: boolean;
}

/** The typed part at the first word that starts with it stays normal; the completion around it is bold. */
export function completionParts(text: string, typed: string): CompletionPart[] {
  const needle = typed.trim().toLowerCase();
  const lower = text.toLowerCase();
  let index = needle ? lower.indexOf(needle) : -1;
  while (index > 0 && /[\p{L}\p{N}]/u.test(lower[index - 1])) index = lower.indexOf(needle, index + 1);
  if (index < 0) return [{ text, bold: true }];
  const end = index + needle.length;
  return [
    { text: text.slice(0, index), bold: true },
    { text: text.slice(index, end), bold: false },
    { text: text.slice(end), bold: true },
  ].filter((part) => part.text);
}

/** The next highlighted row; -1 is no row, where Enter searches the typed text. Both ends wrap. */
export function moveActive(active: number, count: number, key: "ArrowDown" | "ArrowUp"): number {
  if (!count) return -1;
  if (key === "ArrowDown") return active >= count - 1 ? 0 : active + 1;
  return active <= 0 ? count - 1 : active - 1;
}

/** Hands out a token per request; only the newest token's answer may be shown. */
export function latestOnly() {
  let newest = 0;
  return {
    next: () => ++newest,
    isCurrent: (token: number) => token === newest,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function resultsMessage(counts: { suggestions: number; aisles: number; products: number }) {
  return [
    counts.suggestions && plural(counts.suggestions, "suggestion"),
    counts.aisles && plural(counts.aisles, "aisle"),
    counts.products && plural(counts.products, "product"),
  ]
    .filter(Boolean)
    .join(", ");
}

/** The searches this browser ran in this store, newest first (stored by `rememberSearch`). */
export function recentSearches(raw: string | null): string[] {
  try {
    const data: unknown = JSON.parse(raw || "[]");
    return Array.isArray(data) ? data.filter((v): v is string => typeof v === "string" && v.length < 100).slice(0, 6) : [];
  } catch {
    return [];
  }
}
