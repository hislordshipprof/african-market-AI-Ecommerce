const USD_FORMS: Array<{ re: RegExp; kind: "dollar" | "cent" }> = [
  { re: /(?:US\$|\$)\s*(\d{1,7})(?:\.(\d{1,2}))?/gi, kind: "dollar" },
  { re: /\bUSD\s*(\d{1,7})(?:\.(\d{1,2}))?/gi, kind: "dollar" },
  { re: /\b(\d{1,7})(?:\.(\d{1,2}))?\s*USD\b/gi, kind: "dollar" },
  { re: /\b(\d{1,7})(?:\.(\d{1,2}))?\s+dollars?\b/gi, kind: "dollar" },
  { re: /\b(\d{1,7})\s*(?:¢|cents?)\b/gi, kind: "cent" },
];

const FOREIGN = /(?:€|£|₦|₵|₹|¥|₩|₽|₺|₱|₫)\s*\d|\b(?:NGN|GHS|EUR|GBP|XOF|CFA|CAD|AUD)\s*\d|\b\d[\d.,]*\s*(?:naira|cedis?|euros?|pounds?)\b/i;

export function centsFromParts(whole: string, frac: string): number | null {
  if (!/^\d+$/.test(whole) || (frac !== "" && !/^\d{1,2}$/.test(frac))) return null;
  const dollars = Number(whole);
  if (!Number.isSafeInteger(dollars)) return null;
  const cents = frac === "" ? 0 : Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  const total = dollars * 100 + cents;
  return Number.isSafeInteger(total) ? total : null;
}

/** Integer cents from USD text. Never uses floating multiplication of a parsed decimal. */
export function usdAmountsInText(text: string): number[] {
  const found: number[] = [];
  for (const form of USD_FORMS) {
    form.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = form.re.exec(text))) {
      const cents = form.kind === "cent"
        ? centsFromParts(match[1] ?? "", "")
        : centsFromParts(match[1] ?? "", match[2] ?? "");
      if (cents != null) found.push(cents);
    }
  }
  return found;
}

export function hasForeignCurrency(text: string): boolean {
  return FOREIGN.test(text);
}

export function formatUsdFromMicros(micros: bigint): string {
  const negative = micros < BigInt(0);
  const abs = negative ? -micros : micros;
  const dollars = abs / BigInt(1000000);
  const frac = (abs % BigInt(1000000)).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${dollars.toString()}.${frac}`;
}

export function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return numerator / denominator;
}
