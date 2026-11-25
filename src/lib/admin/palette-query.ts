export const PALETTE_QUERY_MAX = 100;
const ORDER_NUMBER = /^#?(\d{1,9})$/;

/** The ⌘K query as store words plus an optional order number (#859). Order numbers are per store, so one needs words. */
export function parsePaletteQuery(query: string): { text: string; number: number | null } {
  const trimmed = query.trim();
  if (trimmed.length < 2 || trimmed.length > PALETTE_QUERY_MAX) return { text: "", number: null };
  let number: number | null = null;
  const words = trimmed.split(/\s+/).filter((word) => {
    if (/^#?\d+$/.test(word)) {
      const match = ORDER_NUMBER.exec(word);
      if (match && number === null) number = Number(match[1]);
      return false;
    }
    return true;
  });
  return { text: words.join(" "), number };
}
