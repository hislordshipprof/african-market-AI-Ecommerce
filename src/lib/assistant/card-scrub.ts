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

function isDigit(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 48 && code <= 57;
}
